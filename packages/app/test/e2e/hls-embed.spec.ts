import { TarArchiver, type TarIndex } from 'bgzf';
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// HLS tar のタイトル/ポスター埋め込み (EXT-X-SESSION-DATA + poster.jpg) と
// それを使った OGP / ActivityPub リンク Note / /e/ 埋め込みページを検証する。

const HLS_TAR_MIME = 'application/vnd.cfw-fileup.hls+tar';
// playwright.config.ts の baseURL と一致させる (Worker が生成する絶対 URL の検証に使う)
const ORIGIN = 'http://127.0.0.1:5173';
// 変換ワーカーが作る HLS tar はルート直置き(ディレクトリプレフィックスなし)
const MASTER_PLAYLIST_PATH = 'master.m3u8';
const MEDIA_PLAYLIST_PATH = 'playlist-0.m3u8';
const SEGMENT_PATH = 'segment-0-0.ts';
const POSTER_PATH = 'poster.jpg';
const CUSTOM_TITLE = 'My Custom Video Title';

function masterPlaylistText(withSessionData: boolean): string {
	return [
		'#EXTM3U',
		'#EXT-X-VERSION:3',
		...(withSessionData ? [
			`#EXT-X-SESSION-DATA:DATA-ID="com.cfw-fileup.hls.title",VALUE="${CUSTOM_TITLE}"`,
			'#EXT-X-SESSION-DATA:DATA-ID="com.cfw-fileup.hls.poster",URI="poster.jpg"',
		] : []),
		'#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=320x180',
		'playlist-0.m3u8',
		'',
	].join('\n');
}

const MEDIA_PLAYLIST_TEXT = [
	'#EXTM3U',
	'#EXT-X-VERSION:3',
	'#EXT-X-PLAYLIST-TYPE:VOD',
	'#EXT-X-TARGETDURATION:2',
	'',
	'#EXTINF:2,',
	'segment-0-0.ts',
	'',
	'#EXT-X-ENDLIST',
	'',
].join('\n');

function createMpegTsSegmentBytes(): Uint8Array<ArrayBuffer> {
	const segment = new Uint8Array(188 * 3);
	for (let offset = 0; offset < segment.length; offset += 188) {
		segment[offset] = 0x47;
	}
	return segment;
}

function createJpegBytes(): Uint8Array<ArrayBuffer> {
	// 最小の JPEG ヘッダ (SOI + APP0 "JFIF") + EOI
	return new Uint8Array([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
		0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
		0xff, 0xd9,
	]);
}

async function buildHlsTar(withMetadata: boolean): Promise<{ tar: Buffer; index: TarIndex[] }> {
	const archiver = await TarArchiver.createFromEntries([
		{ path: MASTER_PLAYLIST_PATH, file: new File([masterPlaylistText(withMetadata)], 'master.m3u8', { type: 'application/vnd.apple.mpegurl' }) },
		{ path: MEDIA_PLAYLIST_PATH, file: new File([MEDIA_PLAYLIST_TEXT], 'playlist-0.m3u8', { type: 'application/vnd.apple.mpegurl' }) },
		{ path: SEGMENT_PATH, file: new File([createMpegTsSegmentBytes()], 'segment-0-0.ts', { type: 'video/mp2t' }) },
		...(withMetadata ? [
			{ path: POSTER_PATH, file: new File([createJpegBytes()], 'poster.jpg', { type: 'image/jpeg' }) },
		] : []),
	]);
	const chunks: Uint8Array[] = [];
	const reader = archiver.stream.getReader();
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return { tar: Buffer.concat(chunks), index: await archiver.index };
}

async function uploadHlsTar(request: APIRequestContext, token: string, withMetadata: boolean): Promise<{ fileId: string; bucketName: string; filePath: string }> {
	const headers = { Authorization: `Bearer ${token}` };

	const bucketName = `e2e_hlsmeta_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`;
	const bucketRes = await request.post('/api/buckets/create', { headers, data: { bucketName } });
	expect(bucketRes.ok(), 'bucket create').toBe(true);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	const { tar, index } = await buildHlsTar(withMetadata);
	const filePath = 'hls-video.tar';
	const openRes = await request.post('/api/files/create/open', { headers, data: { bucketId, path: filePath } });
	expect(openRes.ok(), 'file open').toBe(true);
	const { fileId } = await openRes.json() as { fileId: string };

	const putRes = await request.put(`/upload/${fileId}`, {
		headers: { ...headers, 'Content-Type': 'application/x-tar' },
		data: tar,
	});
	expect(putRes.ok(), 'tar upload').toBe(true);

	const indexRes = await request.post('/api/files/create/tar-index', { headers, data: { fileId, files: index } });
	expect(indexRes.ok(), 'tar index').toBe(true);

	// HLS tar として閉じる (アップローダーと同じく mimeType を明示)
	const closeRes = await request.post('/api/files/create/close', {
		headers,
		data: { fileId, visibility: 'public', isListed: true, mimeType: HLS_TAR_MIME },
	});
	expect(closeRes.ok(), 'file close').toBe(true);

	return { fileId, bucketName, filePath };
}

test.describe('HLS metadata embedding', () => {
	test('view page HTML has player OGP from embedded title/poster', async ({ request, adminUser }) => {
		const { fileId, bucketName, filePath } = await uploadHlsTar(request, adminUser.token, true);

		const res = await request.get(`/v/${bucketName}/${filePath}`);
		expect(res.status()).toBe(200);
		const html = await res.text();
		expect(html).toContain(`<meta property="og:title" content="${CUSTOM_TITLE}">`);
		expect(html).toContain('<meta property="og:type" content="video.other">');
		expect(html).toContain(`<meta name="twitter:player" content="${ORIGIN}/e/${fileId}">`);
		expect(html).toContain('<meta name="twitter:card" content="player">');
		expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/d/${fileId}/%3Aentries/poster.jpg">`);
	});

	test('view page HTML falls back to filename and omits og:image without metadata', async ({ request, adminUser }) => {
		const { fileId, bucketName, filePath } = await uploadHlsTar(request, adminUser.token, false);

		const res = await request.get(`/v/${bucketName}/${filePath}`);
		expect(res.status()).toBe(200);
		const html = await res.text();
		expect(html).toContain(`<meta property="og:title" content="${filePath}">`);
		expect(html).toContain(`<meta name="twitter:player" content="${ORIGIN}/e/${fileId}">`);
		expect(html).not.toContain('og:image');
	});

	test('ActivityPub note for HLS tar links the view page instead of attaching the tar', async ({ request, adminUser }) => {
		const { fileId, bucketName, filePath } = await uploadHlsTar(request, adminUser.token, true);

		const res = await request.get(`/a/files/${fileId}`, {
			headers: { Accept: 'application/activity+json' },
		});
		expect(res.status()).toBe(200);
		const note = await res.json() as {
			type: string;
			name?: string;
			url?: Array<{ type: string; mediaType: string; href: string }>;
			content?: string;
			attachment?: unknown;
		};
		expect(note.type).toBe('Note');
		expect(note.attachment).toBeUndefined();
		expect(note.name).toBeUndefined();
		const viewUrl = `${ORIGIN}/v/${bucketName}/${filePath}`;
		expect(note.content).toContain(`<a href="${viewUrl}">`);
		expect(note.content).toContain(CUSTOM_TITLE);
		expect(note.url).toEqual(expect.arrayContaining([
			expect.objectContaining({
				type: 'Link',
				mediaType: 'text/html',
				href: viewUrl,
			}),
			expect.objectContaining({
				type: 'Link',
				mediaType: 'application/x-mpegURL',
				href: `${ORIGIN}/d/${fileId}/%3Aentries/master.m3u8`,
			}),
		]));
	});

	test('embed page /e/:fileId serves the embed SPA shell', async ({ request, adminUser }) => {
		const { fileId } = await uploadHlsTar(request, adminUser.token, true);

		const res = await request.get(`/e/${fileId}`);
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('text/html');
		// iframe 埋め込みを阻害するヘッダが付いていない
		expect(res.headers()['x-frame-options']).toBeUndefined();

		const html = await res.text();
		const configMatch = /<script type="application\/json" id="embed-config">(.*?)<\/script>/s.exec(html);
		expect(configMatch).not.toBeNull();
		expect(configMatch?.[1]).toBe('{}');
	});

	test('embed page /e/:fileId keeps autoplay=1 in the URL only', async ({ request, adminUser }) => {
		const { fileId } = await uploadHlsTar(request, adminUser.token, true);

		const res = await request.get(`/e/${fileId}?autoplay=1`);
		expect(res.status()).toBe(200);

		const html = await res.text();
		const configMatch = /<script type="application\/json" id="embed-config">(.*?)<\/script>/s.exec(html);
		expect(configMatch).not.toBeNull();
		expect(configMatch?.[1]).toBe('{}');
	});

	test('root poster.jpg entry URL serves the poster for directory thumbnails', async ({ request, adminUser }) => {
		const { fileId } = await uploadHlsTar(request, adminUser.token, true);

		// ディレクトリブラウザのサムネはこのURLを決め打ちで指す
		const res = await request.get(`/d/${fileId}/%3Aentries/poster.jpg`);
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('image/jpeg');
		expect(Buffer.from(await res.body()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
	});

	test('root poster.jpg entry URL 404s when the HLS tar has no poster', async ({ request, adminUser }) => {
		const { fileId } = await uploadHlsTar(request, adminUser.token, false);

		expect((await request.get(`/d/${fileId}/%3Aentries/poster.jpg`)).status()).toBe(404);
	});

	test('uploader file menu opens HLS settings dialog for HLS-planned entries', async ({ loggedInPage }) => {
		await loggedInPage.goto('/uploader');

		// HLS 変換対象と判定されるよう、MediaRecorder で実際にデコード可能な動画を生成する
		const videoBytes = await loggedInPage.evaluate(async () => {
			const canvas = document.createElement('canvas');
			canvas.width = 64;
			canvas.height = 64;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('Canvas 2D context unavailable');
			const stream = canvas.captureStream(10);
			const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
			const chunks: Blob[] = [];
			recorder.ondataavailable = (event) => chunks.push(event.data);
			const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
			recorder.start();
			for (let i = 0; i < 8; i++) {
				context.fillStyle = i % 2 === 0 ? '#f00' : '#00f';
				context.fillRect(0, 0, 64, 64);
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			recorder.stop();
			await stopped;
			const blob = new Blob(chunks, { type: 'video/webm' });
			return Array.from(new Uint8Array(await blob.arrayBuffer()));
		});

		await loggedInPage.locator('input[type=file]').first().setInputFiles({
			name: 'movie.webm',
			mimeType: 'video/webm',
			buffer: Buffer.from(videoBytes),
		});
		await expect(loggedInPage.getByText('movie.webm').first()).toBeVisible();

		// HLS 変換が計画されていない間はメニューに HLS設定 が出ない
		await loggedInPage.getByRole('button', { name: 'ファイル操作メニュー' }).first().click();
		await expect(loggedInPage.getByRole('button', { name: '削除' })).toBeVisible();
		await expect(loggedInPage.getByRole('button', { name: 'HLS設定' })).toHaveCount(0);
		await loggedInPage.keyboard.press('Escape');

		// メディア縮小設定で HLS 出力を有効化
		await loggedInPage.getByRole('button', { name: 'メディア縮小設定' }).click();
		const videoSection = loggedInPage.locator('section', { hasText: '動画' }).last();
		await videoSection.locator('input[type=checkbox]').check();
		await videoSection.locator('select').first().selectOption('application/vnd.apple.mpegurl');
		await loggedInPage.getByRole('button', { name: '閉じる', exact: true }).last().click();

		// メニューに HLS設定 が出て、ダイアログでタイトルを設定できる
		await loggedInPage.getByRole('button', { name: 'ファイル操作メニュー' }).first().click();
		await loggedInPage.getByRole('button', { name: 'HLS設定' }).click();
		const dialog = loggedInPage.locator('dialog', { hasText: 'HLS設定' });
		await expect(dialog.getByText('ポスター画像は未設定です。')).toBeVisible();
		await dialog.getByPlaceholder('動画のタイトル').fill('テスト動画');
		await dialog.getByRole('button', { name: '完了' }).click();

		// 再度開くと保持されている
		await loggedInPage.getByRole('button', { name: 'ファイル操作メニュー' }).first().click();
		await loggedInPage.getByRole('button', { name: 'HLS設定' }).click();
		await expect(dialog.getByPlaceholder('動画のタイトル')).toHaveValue('テスト動画');
	});

	test('embed page serves the SPA shell for non-HLS files and missing files', async ({ request, adminUser }) => {
		const headers = { Authorization: `Bearer ${adminUser.token}` };
		const bucketName = `e2e_hlsmeta_plain_${Date.now().toString(36)}`;
		const bucketRes = await request.post('/api/buckets/create', { headers, data: { bucketName } });
		expect(bucketRes.ok()).toBe(true);
		const { bucketId } = await bucketRes.json() as { bucketId: string };
		const openRes = await request.post('/api/files/create/open', { headers, data: { bucketId, path: 'plain.txt' } });
		const { fileId } = await openRes.json() as { fileId: string };
		await request.put(`/upload/${fileId}`, { headers: { ...headers, 'Content-Type': 'text/plain' }, data: 'hello' });
		const closeRes = await request.post('/api/files/create/close', { headers, data: { fileId, visibility: 'public', isListed: true } });
		expect(closeRes.ok()).toBe(true);

		expect((await request.get(`/e/${fileId}`)).status()).toBe(200);
		expect((await request.get('/e/nonexistent')).status()).toBe(200);
	});
});
