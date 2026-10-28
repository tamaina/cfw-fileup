import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { genEaidx } from '../../src/shared/eaid-x';
import { HLS_SESSION_DATA_TITLE_ID, HLS_TAR_MIME } from '../../src/shared/hls';
import { deleteAppSettingCache } from '../../src/worker/utils/app-settings-cache';
import { getDb } from '../../src/worker/utils/db';
import { getHlsTarMetadata } from '../../src/worker/utils/hls-tar-metadata';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

// Cache API への put は waitUntil（テストでは投げっぱなし）で行うので、少し待ってから次のリクエストを送る
async function flushBackgroundTasks(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 20));
}

async function adminRequest(path: string, token: string, body: unknown): Promise<Response> {
	return await app.request(path, {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify(body),
	}, env);
}

async function setupPublicFile(path: string) {
	const { data } = await signup('owner');
	const token = String(data.token);
	const bucketRes = await adminRequest('/api/buckets/create', token, { bucketName: 'cache_bucket' });
	const { bucketId } = await bucketRes.json() as { bucketId: string };
	const openRes = await adminRequest('/api/files/create/open', token, { bucketId, path });
	const { fileId } = await openRes.json() as { fileId: string };
	await env.R2.put(fileId, 'hello');
	const closeRes = await adminRequest('/api/files/create/close', token, { fileId, visibility: 'public', isListed: true });
	expect(closeRes.status).toBe(200);
	return { token, bucketId, fileId };
}

describe('IP ban list cache', () => {
	const bannedHeaders = { 'CF-Connecting-IP': '198.51.100.7' };

	test('admin create/delete refreshes the local copy immediately', async () => {
		const { data } = await signup('admin');
		const adminToken = String(data.token);

		// 空の BAN 一覧をキャッシュさせる
		expect((await app.request('/api/meta', { headers: bannedHeaders }, env)).status).toBe(200);
		await flushBackgroundTasks();

		const createRes = await adminRequest('/api/admin/create-ip-ban', adminToken, { cidr: '198.51.100.0/24' });
		expect(createRes.status).toBe(200);
		const { id: banId } = await createRes.json() as { id: string };

		const bannedRes = await app.request('/api/meta', { headers: bannedHeaders }, env);
		expect(bannedRes.status).toBe(403);
		expect(await bannedRes.json()).toMatchObject({ error: 'IP_BANNED' });
		await flushBackgroundTasks();

		const deleteRes = await adminRequest('/api/admin/delete-ip-ban', adminToken, { banId });
		expect(deleteRes.status).toBe(200);

		expect((await app.request('/api/meta', { headers: bannedHeaders }, env)).status).toBe(200);
	});

	test('a ban written elsewhere (another colo) applies after the cached list expires, not immediately', async () => {
		expect((await app.request('/api/meta', { headers: bannedHeaders }, env)).status).toBe(200);
		await flushBackgroundTasks();

		// 他のデータセンターの管理画面から追加された場合を DB 直書きで再現する（この colo のキャッシュは消えない）
		await env.DB.prepare('INSERT INTO ip_bans (id, cidr) VALUES (?, ?)').bind(genEaidx(Date.now()), '198.51.100.0/24').run();
		expect((await app.request('/api/meta', { headers: bannedHeaders }, env)).status).toBe(200);
	});

	test('expiresAt is checked on every request even when the list is cached', async () => {
		await env.DB.prepare('INSERT INTO ip_bans (id, cidr, expires_at) VALUES (?, ?, ?)')
			.bind(genEaidx(Date.now()), '198.51.100.0/24', Date.now() + 300)
			.run();

		expect((await app.request('/api/meta', { headers: bannedHeaders }, env)).status).toBe(403);
		await flushBackgroundTasks();
		await new Promise(resolve => setTimeout(resolve, 400));
		expect((await app.request('/api/meta', { headers: bannedHeaders }, env)).status).toBe(200);
	});
});

describe('GET /api/meta cache', () => {
	test('serves the cached response (ignoring query strings) and is invalidated by admin setting updates', async () => {
		const { data } = await signup('admin');
		const adminToken = String(data.token);
		await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'app_name\', \'First\') ON CONFLICT(key) DO UPDATE SET value = \'First\'').run();

		const firstRes = await app.request('/api/meta', {}, env);
		expect(firstRes.headers.get('Cache-Control')).toBe('public, max-age=10');
		expect(await firstRes.json()).toMatchObject({ appName: 'First' });
		await flushBackgroundTasks();

		// DB を直接変えてもキャッシュが返る（クエリ文字列が違っても同じキャッシュ）
		await env.DB.prepare('UPDATE app_settings SET value = \'Direct\' WHERE key = \'app_name\'').run();
		const cachedRes = await app.request('/api/meta?foo=bar', {}, env);
		expect(cachedRes.headers.get('Cache-Control')).toBe('public, max-age=10');
		expect(cachedRes.headers.get('X-Cfw-Fileup-Cache-Expires')).toBeNull();
		expect(await cachedRes.json()).toMatchObject({ appName: 'First' });

		// 管理画面から保存するとこの colo のキャッシュが消える
		const updateRes = await adminRequest('/api/admin/update-setting', adminToken, { key: 'app_name', value: 'Second' });
		expect(updateRes.status).toBe(200);
		expect(await (await app.request('/api/meta', {}, env)).json()).toMatchObject({ appName: 'Second' });
	});

	test('read-only admin calls do not invalidate the cache', async () => {
		const { data } = await signup('admin');
		const adminToken = String(data.token);
		await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'app_name\', \'First\') ON CONFLICT(key) DO UPDATE SET value = \'First\'').run();
		expect(await (await app.request('/api/meta', {}, env)).json()).toMatchObject({ appName: 'First' });
		await flushBackgroundTasks();

		await env.DB.prepare('UPDATE app_settings SET value = \'Direct\' WHERE key = \'app_name\'').run();
		expect((await adminRequest('/api/admin/get-settings', adminToken, {})).status).toBe(200);
		expect(await (await app.request('/api/meta', {}, env)).json()).toMatchObject({ appName: 'First' });
	});
});

describe('GET /api/files/ls cache', () => {
	test('caches by full URL and global cache version', async () => {
		const { fileId } = await setupPublicFile('cached.txt');
		const url = '/api/files/ls?bucketName=cache_bucket&path=';

		const firstRes = await app.request(url, {}, env);
		expect(firstRes.status).toBe(200);
		expect(firstRes.headers.get('Cache-Control')).toBe('public, max-age=10');
		expect(JSON.stringify(await firstRes.json())).toContain('cached.txt');
		await flushBackgroundTasks();

		await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId).run();

		// 同じ URL はキャッシュから返る
		const hitRes = await app.request(url, {}, env);
		expect(hitRes.headers.get('Cache-Control')).toBe('public, max-age=10');
		expect(hitRes.headers.get('X-Cfw-Fileup-Cache-Expires')).toBeNull();
		expect(JSON.stringify(await hitRes.json())).toContain('cached.txt');

		// クエリが違えば別のキー
		const otherQueryRes = await app.request(`${url}&limit=50`, {}, env);
		expect(JSON.stringify(await otherQueryRes.json())).not.toContain('cached.txt');

		// 全体のキャッシュバージョンを上げると同じ URL でも取り直す
		await env.DB.prepare('UPDATE app_settings SET value = ? WHERE key = \'worker_cache_version\'').bind(`bumped-${Date.now()}`).run();
		await deleteAppSettingCache('worker_cache_version');
		const afterBumpRes = await app.request(url, {}, env);
		expect(JSON.stringify(await afterBumpRes.json())).not.toContain('cached.txt');
	});

	test('does not cache error responses', async () => {
		const missingRes = await app.request('/api/files/ls?bucketName=later_bucket&path=', {}, env);
		expect(missingRes.status).not.toBe(200);
		await flushBackgroundTasks();

		const { data } = await signup('owner');
		await adminRequest('/api/buckets/create', String(data.token), { bucketName: 'later_bucket' });
		expect((await app.request('/api/files/ls?bucketName=later_bucket&path=', {}, env)).status).toBe(200);
	});
});

describe('HLS tar metadata cache', () => {
	const activityJson = { headers: { Accept: 'application/activity+json' } };

	function masterPlaylist(title: string): string {
		return `#EXTM3U\n#EXT-X-SESSION-DATA:DATA-ID="${HLS_SESSION_DATA_TITLE_ID}",VALUE="${title}"\n`;
	}

	// アップロード期限内（クローズ後も tar index を追加できる期間）のクローズ済みファイルを作る
	async function setupHlsFile() {
		const { token, bucketId, fileId } = await setupPublicFile('video.tar');
		const master = masterPlaylist('Cached title');
		await env.R2.put(fileId, master);
		await env.DB.prepare('UPDATE files SET mime_type = ?, is_tar = 1, upload_expires_at = ? WHERE id = ?')
			.bind(HLS_TAR_MIME, Date.now() + 60 * 60_000, fileId)
			.run();
		await env.DB.prepare('INSERT INTO tar_files (id, file_id, path, mime_type, offset, size) VALUES (?, ?, ?, ?, ?, ?)')
			.bind(genEaidx(Date.now()), fileId, 'master.m3u8', 'application/vnd.apple.mpegurl', 0, master.length)
			.run();
		return { token, bucketId, fileId };
	}

	async function noteText(fileId: string): Promise<{ status: number; text: string }> {
		const res = await app.request(`https://example.test/a/files/${fileId}`, activityJson, env);
		return { status: res.status, text: await res.text() };
	}

	function envWithAssets(): Env {
		return {
			...env,
			ASSETS: {
				fetch: () => new Response('<!doctype html><html><head><title>CFW FileUp</title></head><body></body></html>', {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				}),
			},
		};
	}

	test('a closed file (even inside the upload deadline) is cached permanently and reused without reading tar entries or R2 again', async () => {
		const { fileId } = await setupHlsFile();

		expect(await noteText(fileId)).toMatchObject({ status: 200, text: expect.stringContaining('Cached title') });

		// tar エントリーも R2 の中身も消してもキャッシュから返る
		await env.DB.prepare('DELETE FROM tar_files WHERE file_id = ?').bind(fileId).run();
		await env.R2.put(fileId, masterPlaylist('Changed title'));
		expect(await noteText(fileId)).toMatchObject({ status: 200, text: expect.stringContaining('Cached title') });

		// /v も同じキャッシュを使う
		const viewRes = await app.request('https://example.test/v/cache_bucket/video.tar', {}, envWithAssets());
		expect(await viewRes.text()).toContain('Cached title');
	});

	test('results for files that are not closed are not cached', async () => {
		const { fileId } = await setupHlsFile();
		const db = getDb(env);
		const notClosedFile = { id: fileId, r2Key: fileId, mimeType: HLS_TAR_MIME, isTar: true, isClosed: false };

		expect(await getHlsTarMetadata(env, db, notClosedFile)).toMatchObject({ title: 'Cached title' });
		await env.R2.put(fileId, masterPlaylist('Changed title'));
		expect(await getHlsTarMetadata(env, db, notClosedFile)).toMatchObject({ title: 'Changed title' });

		// クローズ前の結果がキャッシュに入っていないので、クローズ済みとして読んでも最新の内容になる
		expect(await getHlsTarMetadata(env, db, { ...notClosedFile, isClosed: true })).toMatchObject({ title: 'Changed title' });
	});

	test('a result from an unreadable R2 object is not cached', async () => {
		const { fileId } = await setupHlsFile();
		await env.R2.delete(fileId);

		expect((await noteText(fileId)).text).not.toContain('Cached title');
		await env.R2.put(fileId, masterPlaylist('Cached title'));
		expect((await noteText(fileId)).text).toContain('Cached title');
	});

	test('bumping the global cache version clears it', async () => {
		const { fileId } = await setupHlsFile();
		expect((await noteText(fileId)).text).toContain('Cached title');

		await env.R2.put(fileId, masterPlaylist('Changed title'));
		await env.DB.prepare('UPDATE app_settings SET value = ? WHERE key = \'worker_cache_version\'').bind(`bumped-${Date.now()}`).run();
		await deleteAppSettingCache('worker_cache_version');
		expect((await noteText(fileId)).text).toContain('Changed title');
	});

	test('the DB visibility check still runs first: forced-private is 404 immediately', async () => {
		const { fileId } = await setupHlsFile();
		expect((await noteText(fileId)).status).toBe(200);

		await env.DB.prepare('UPDATE files SET is_moderation_forced_private = 1 WHERE id = ?').bind(fileId).run();
		expect((await noteText(fileId)).status).toBe(404);
	});

	test('the DB visibility check still runs first: unlisting is 404 immediately', async () => {
		const { fileId } = await setupHlsFile();
		expect((await noteText(fileId)).status).toBe(200);

		await env.DB.prepare('UPDATE files SET is_listed = 0 WHERE id = ?').bind(fileId).run();
		expect((await noteText(fileId)).status).toBe(404);
	});
});
