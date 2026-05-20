import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { genEaidx, parseEaidx } from '../../src/shared/eaid-x';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupPublicFile() {
	const { data } = await signup('user1');
	const token = String(data.token);

	const bucketRes = await app.request('/api/buckets/create', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketName: 'test_bucket' }),
	}, env);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	const openRes = await app.request('/api/files/create/open', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketId, path: 'hello.txt' }),
	}, env);
	const { fileId } = await openRes.json() as { fileId: string };

	await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');

	await app.request('/api/files/create/close', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ fileId, visibility: 'public' }),
	}, env);

	return { token, bucketId, fileId };
}

async function setupBucket(username: string) {
	const { data } = await signup(username);
	const token = String(data.token);
	const userId = String(data.userId);

	const bucketRes = await app.request('/api/buckets/create', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketName: `${username}_bucket` }),
	}, env);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	return { token, userId, bucketId };
}

async function insertPublicFile(options: {
	fileId: string;
	bucketId: string;
	userId: string;
	path: string;
	body: string;
}): Promise<void> {
	const r2Key = `${options.bucketId}/${options.path}`;
	await env.R2.put(r2Key, options.body);
	await env.DB.prepare(`
		INSERT INTO files (
			id, bucket_id, user_id, path, r2_key, size, mime_type, visibility,
			upload_expires_at, is_closed, is_targz, is_tar, part_size
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?, 1, 0, 0, ?)
	`).bind(
		options.fileId,
		options.bucketId,
		options.userId,
		options.path,
		r2Key,
		options.body.length,
		'text/plain',
		Date.now() + 60_000,
		32 * 1024 * 1024,
	).run();
}

describe('GET /d/:fileId', () => {
	test('downloads a public file', async () => {
		const { fileId } = await setupPublicFile();

		const res = await app.request(`/d/${fileId}`, {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=315360000, immutable');
		expect(res.headers.get('Last-Modified')).toBe(parseEaidx(fileId).date.toUTCString());
		const text = await res.text();
		expect(text).toBe('Hello World');
	});

	test('serves a public file from Cache API after first download', async () => {
		const { bucketId, fileId } = await setupPublicFile();

		const firstRes = await app.request(`/d/${fileId}`, {}, env);
		expect(firstRes.status).toBe(200);
		expect(await firstRes.text()).toBe('Hello World');

		await new Promise((resolve) => setTimeout(resolve, 0));
		await env.R2.delete(`${bucketId}/hello.txt`);

		const cachedRes = await app.request(`/d/${fileId}`, {}, env);
		expect(cachedRes.status).toBe(200);
		expect(cachedRes.headers.get('Cache-Control')).toBe('public, max-age=315360000, immutable');
		expect(cachedRes.headers.get('Last-Modified')).toBe(parseEaidx(fileId).date.toUTCString());
		expect(await cachedRes.text()).toBe('Hello World');
	});

	test('deleted file does not return stale public download cache', async () => {
		const { token, bucketId, fileId } = await setupPublicFile();

		const firstRes = await app.request(`/d/${fileId}`, {}, env);
		expect(firstRes.status).toBe(200);
		expect(await firstRes.text()).toBe('Hello World');

		const deleteRes = await app.request('/api/files/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(deleteRes.status).toBe(200);

		await new Promise((resolve) => setTimeout(resolve, 0));

		const afterDeleteRes = await app.request(`/d/${fileId}`, {}, env);
		expect(afterDeleteRes.status).toBe(404);
	});

	test('invalid access key returns 400', async () => {
		const res = await app.request('/d/nonexistent_access_key_xyz', {}, env);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Invalid file ID' });
	});

	test('missing past EAID-X file is cached as 404 before file lookup', async () => {
		const fileId = genEaidx(Date.now() - 60_000);

		const firstRes = await app.request(`/d/${fileId}`, {}, env);
		expect(firstRes.status).toBe(404);
		expect(firstRes.headers.get('Cache-Control')).toBe('public, max-age=315360000');
		expect(await firstRes.json()).toEqual({ error: 'File not found' });

		await new Promise((resolve) => setTimeout(resolve, 0));

		const { userId, bucketId } = await setupBucket('cached404past');
		await insertPublicFile({
			fileId,
			bucketId,
			userId,
			path: 'created-after-cache.txt',
			body: 'Created after negative cache',
		});

		const cachedRes = await app.request(`/d/${fileId}`, {}, env);
		expect(cachedRes.status).toBe(404);
		expect(cachedRes.headers.get('Cache-Control')).toBe('public, max-age=315360000');
		expect(await cachedRes.json()).toEqual({ error: 'File not found' });
	});

	test('missing future EAID-X file is cached until the ID timestamp', async () => {
		const fileId = genEaidx(Date.now() + 2_000);
		const fileDate = parseEaidx(fileId).date;

		const firstRes = await app.request(`/d/${fileId}`, {}, env);
		expect(firstRes.status).toBe(404);
		expect(firstRes.headers.get('Expires')).toBe(fileDate.toUTCString());
		const cacheControl = firstRes.headers.get('Cache-Control');
		expect(cacheControl).toMatch(/^public, max-age=\d+$/);
		const maxAge = Number(cacheControl?.slice('public, max-age='.length));
		expect(maxAge).toBeGreaterThanOrEqual(0);
		expect(maxAge).toBeLessThanOrEqual(2);

		await new Promise((resolve) => setTimeout(resolve, 0));

		const { userId, bucketId } = await setupBucket('cached404future');
		await insertPublicFile({
			fileId,
			bucketId,
			userId,
			path: 'created-after-future-cache.txt',
			body: 'Created before negative cache expires',
		});

		const cachedRes = await app.request(`/d/${fileId}`, {}, env);
		expect(cachedRes.status).toBe(404);

		await new Promise((resolve) => setTimeout(resolve, Math.max(0, fileDate.getTime() - Date.now()) + 1_100));

		const afterExpiryRes = await app.request(`/d/${fileId}`, {}, env);
		expect(afterExpiryRes.status).toBe(200);
		expect(await afterExpiryRes.text()).toBe('Created before negative cache expires');
	});

	test('private file without token returns 403', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'secret_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'passphrase', passphrase: 'mypassword' }),
		}, env);

		const res = await app.request(`/d/${fileId}`, {}, env);
		expect(res.status).toBe(403);
	});

	test('private file with file access token returns content', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'secret_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'passphrase', passphrase: 'mypassword' }),
		}, env);

		const tokenRes = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName: 'secret_bucket', filePath: 'secret.txt', passphrase: 'mypassword' }),
		}, env);
		expect(tokenRes.status).toBe(200);
		const { token: fileToken, expiresAt, fileId: tokenFileId } = await tokenRes.json() as { token: string; expiresAt: number; fileId: string };

		const res = await app.request(`/d/${tokenFileId}?token=${fileToken}`, {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Expires')).toBe(new Date(expiresAt).toUTCString());
		expect(res.headers.get('Cache-Control')).toBeNull();
		expect(await res.text()).toBe('Secret Content');
	});

	test('expired file access token response is cached permanently for that token', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'secret_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'passphrase', passphrase: 'mypassword' }),
		}, env);

		const tokenRes = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'secret_bucket', filePath: 'secret.txt', expiresIn: null }),
		}, env);
		expect(tokenRes.status).toBe(200);
		const { token: fileToken, id: tokenId } = await tokenRes.json() as { token: string; id: string };

		await env.DB.prepare('UPDATE file_access_tokens SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, tokenId).run();

		const expiredRes = await app.request(`/d/${fileId}?token=${fileToken}`, {}, env);
		expect(expiredRes.status).toBe(403);
		expect(expiredRes.headers.get('Cache-Control')).toBeNull();
		expect(await expiredRes.text()).toBe('Forbidden');

		await new Promise((resolve) => setTimeout(resolve, 0));
		await env.DB.prepare('UPDATE file_access_tokens SET expires_at = ? WHERE id = ?').bind(Date.now() + 60_000, tokenId).run();

		const cachedExpiredRes = await app.request(`/d/${fileId}?token=${fileToken}`, {}, env);
		expect(cachedExpiredRes.status).toBe(403);
		expect(cachedExpiredRes.headers.get('Cache-Control')).toBeNull();
		expect(await cachedExpiredRes.text()).toBe('Forbidden');
	});

	test('private file with passphrase query returns 403', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'secret_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'passphrase', passphrase: 'mypassword' }),
		}, env);

		const res = await app.request(`/d/${fileId}?passphrase=mypassword`, {}, env);
		expect(res.status).toBe(403);
	});
});

describe('GET /d/:fileId?list (tar.gz index)', () => {
	test('returns list of files in tar.gz', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'archive_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar.gz' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Register tar.gz index
		await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [
					{
						path: 'dir/file1.txt',
						mimeType: 'text/plain',
						aStart: 0,
						aFirstEnd: 512,
						aFinalStart: 512,
						aEnd: 512,
						rStartOffset: 0,
						rEndOffset: 0,
					},
					{
						path: 'dir/file2.txt',
						mimeType: 'text/plain',
						aStart: 512,
						aFirstEnd: 1024,
						aFinalStart: 1024,
						aEnd: 1024,
						rStartOffset: 0,
						rEndOffset: 0,
					},
				],
			}),
		}, env);

		// Put dummy R2 data and close
		await env.R2.put(`${bucketId}/archive.tar.gz`, new Uint8Array(2048));
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		// List all files
		const listRes = await app.request(`/d/${fileId}?list`, {}, env);
		expect(listRes.status).toBe(200);
		const entries = await listRes.json() as { path: string }[];
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.path)).toContain('dir/file1.txt');
	});

	test('?list=dir filters by path prefix', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'archive_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar.gz' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [
					{ path: 'dir/file1.txt', mimeType: 'text/plain', aStart: 0, aFirstEnd: 512, aFinalStart: 512, aEnd: 512, rStartOffset: 0, rEndOffset: 0 },
					{ path: 'other/file2.txt', mimeType: 'text/plain', aStart: 512, aFirstEnd: 1024, aFinalStart: 1024, aEnd: 1024, rStartOffset: 0, rEndOffset: 0 },
				],
			}),
		}, env);

		await env.R2.put(`${bucketId}/archive.tar.gz`, new Uint8Array(2048));
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		const listRes = await app.request(`/d/${fileId}?list=dir/file1.txt`, {}, env);
		expect(listRes.status).toBe(200);
		const entries = await listRes.json() as { path: string }[];
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe('dir/file1.txt');
	});
});

describe('GET /d/:fileId?file= (tar individual file)', () => {
	test('?file= downloads the correct bytes from a plain tar', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'tar_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Construct a minimal tar in memory: 512-byte header + file content
		const fileContent = new TextEncoder().encode('Hello from tar!');
		const tar = new Uint8Array(512 + fileContent.length);
		tar.set(fileContent, 512);
		await env.R2.put(`${bucketId}/archive.tar`, tar);

		await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'hello.txt', mimeType: 'text/plain', offset: 512, size: fileContent.length }],
			}),
		}, env);

		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		const res = await app.request(`/d/${fileId}?file=hello.txt`, {}, env);
		expect(res.status).toBe(200);
		const body = await res.arrayBuffer();
		expect(new Uint8Array(body)).toEqual(fileContent);
	});

	test('?file= returns 404 for unknown path', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'tar_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/archive.tar`, new Uint8Array(1024));

		await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'hello.txt', mimeType: 'text/plain', offset: 512, size: 11 }],
			}),
		}, env);

		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		const res = await app.request(`/d/${fileId}?file=nonexistent.txt`, {}, env);
		expect(res.status).toBe(404);
	});
});
