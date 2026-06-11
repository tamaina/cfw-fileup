import { TarArchiver, type TarIndex } from 'bgzf';
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// 疑似 HLS 構造 (master + メディアプレイリスト + MPEG-TS セグメント) を tar にして
// アップロードし、配信 MIME・エントリー一覧のプレイリスト表示・専用プレビューを検証する。

const HLS_DIR = 'myvideo';
const MASTER_PLAYLIST_PATH = `${HLS_DIR}/master.m3u8`;
const MEDIA_PLAYLIST_PATH = `${HLS_DIR}/playlist-0.m3u8`;
const SEGMENT_PATH = `${HLS_DIR}/segment-0-0.ts`;
// CMAF (fMP4) バリアント: av1/vp9/opus などはこちらの形式で出力される
const CMAF_PLAYLIST_PATH = `${HLS_DIR}/playlist-1.m3u8`;
const CMAF_INIT_PATH = `${HLS_DIR}/init-1.mp4`;
const CMAF_SEGMENT_PATH = `${HLS_DIR}/segment-1-0.m4s`;

const MASTER_PLAYLIST_TEXT = [
	'#EXTM3U',
	'#EXT-X-VERSION:3',
	'#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=320x180',
	'playlist-0.m3u8',
	'#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=640x360,CODECS="av01.0.04M.08"',
	'playlist-1.m3u8',
	'',
].join('\n');

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

const CMAF_PLAYLIST_TEXT = [
	'#EXTM3U',
	'#EXT-X-VERSION:6',
	'#EXT-X-PLAYLIST-TYPE:VOD',
	'#EXT-X-TARGETDURATION:2',
	'#EXT-X-MAP:URI="init-1.mp4"',
	'',
	'#EXTINF:2,',
	'segment-1-0.m4s',
	'',
	'#EXT-X-ENDLIST',
	'',
].join('\n');

function createMpegTsSegmentBytes(): Uint8Array<ArrayBuffer> {
	// MPEG-TS は 188 バイト境界ごとに 0x47 の sync byte を持つ
	const segment = new Uint8Array(188 * 3);
	for (let offset = 0; offset < segment.length; offset += 188) {
		segment[offset] = 0x47;
	}
	return segment;
}

function createCmafInitBytes(): Uint8Array<ArrayBuffer> {
	// 最小の ftyp box (brand: isom)
	return new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1]);
}

function createCmafSegmentBytes(): Uint8Array<ArrayBuffer> {
	// 最小の styp box (brand: msdh)
	return new Uint8Array([0, 0, 0, 16, 0x73, 0x74, 0x79, 0x70, 0x6d, 0x73, 0x64, 0x68, 0, 0, 0, 1]);
}

async function buildHlsTar(): Promise<{ tar: Buffer; index: TarIndex[] }> {
	const archiver = await TarArchiver.createFromEntries([
		{ path: MASTER_PLAYLIST_PATH, file: new File([MASTER_PLAYLIST_TEXT], 'master.m3u8', { type: 'application/vnd.apple.mpegurl' }) },
		{ path: MEDIA_PLAYLIST_PATH, file: new File([MEDIA_PLAYLIST_TEXT], 'playlist-0.m3u8', { type: 'application/vnd.apple.mpegurl' }) },
		{ path: SEGMENT_PATH, file: new File([createMpegTsSegmentBytes()], 'segment-0-0.ts', { type: 'video/mp2t' }) },
		{ path: CMAF_PLAYLIST_PATH, file: new File([CMAF_PLAYLIST_TEXT], 'playlist-1.m3u8', { type: 'application/vnd.apple.mpegurl' }) },
		// mediabunny の CMAF 出力は init/セグメントとも video/mp4 を報告する
		{ path: CMAF_INIT_PATH, file: new File([createCmafInitBytes()], 'init-1.mp4', { type: 'video/mp4' }) },
		{ path: CMAF_SEGMENT_PATH, file: new File([createCmafSegmentBytes()], 'segment-1-0.m4s', { type: 'video/mp4' }) },
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

interface UploadedHlsTar {
	fileId: string;
	bucketName: string;
	filePath: string;
}

async function uploadHlsTar(request: APIRequestContext, token: string): Promise<UploadedHlsTar> {
	const headers = { Authorization: `Bearer ${token}` };

	const bucketName = `e2e_hls_${Date.now().toString(36)}`;
	const bucketRes = await request.post('/api/buckets/create', { headers, data: { bucketName } });
	expect(bucketRes.ok(), 'bucket create').toBe(true);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	const { tar, index } = await buildHlsTar();
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

	const closeRes = await request.post('/api/files/create/close', {
		headers,
		data: { fileId, visibility: 'public', isListed: true },
	});
	expect(closeRes.ok(), 'file close').toBe(true);

	return { fileId, bucketName, filePath };
}

function entryUrl(fileId: string, entryPath: string): string {
	// スラッシュ温存のエントリーURL (HLS の相対パス解決に使う形)
	return `/d/${fileId}/${encodeURIComponent(':entries')}/${entryPath}`;
}

test.describe('HLS streaming', () => {
	test('serves m3u8 and ts entries with streaming mime types', async ({ request, adminUser }) => {
		const { fileId } = await uploadHlsTar(request, adminUser.token);

		const masterRes = await request.get(entryUrl(fileId, MASTER_PLAYLIST_PATH));
		expect(masterRes.status()).toBe(200);
		expect(masterRes.headers()['content-type']).toBe('application/vnd.apple.mpegurl');
		expect(await masterRes.text()).toContain('playlist-0.m3u8');

		const playlistRes = await request.get(entryUrl(fileId, MEDIA_PLAYLIST_PATH));
		expect(playlistRes.status()).toBe(200);
		expect(playlistRes.headers()['content-type']).toBe('application/vnd.apple.mpegurl');
		expect(await playlistRes.text()).toContain('segment-0-0.ts');

		const segmentRes = await request.get(entryUrl(fileId, SEGMENT_PATH));
		expect(segmentRes.status()).toBe(200);
		expect(segmentRes.headers()['content-type']).toBe('video/mp2t');
		expect((await segmentRes.body()).length).toBe(188 * 3);

		// CMAF (fMP4) のバリアント
		const cmafInitRes = await request.get(entryUrl(fileId, CMAF_INIT_PATH));
		expect(cmafInitRes.status()).toBe(200);
		expect(cmafInitRes.headers()['content-type']).toBe('video/mp4');

		const cmafSegmentRes = await request.get(entryUrl(fileId, CMAF_SEGMENT_PATH));
		expect(cmafSegmentRes.status()).toBe(200);
		expect(cmafSegmentRes.headers()['content-type']).toBe('video/iso.segment');

		// エントリー一覧 (?list) にもプレイリストがストリーミング用 MIME で記録されている
		const listRes = await request.get(`/d/${fileId}?list`);
		expect(listRes.status()).toBe(200);
		const list = await listRes.json() as { path: string; mimeType: string }[];
		const mimeByPath = new Map(list.map(entry => [entry.path, entry.mimeType]));
		expect(mimeByPath.get(MASTER_PLAYLIST_PATH)).toBe('application/vnd.apple.mpegurl');
		expect(mimeByPath.get(MEDIA_PLAYLIST_PATH)).toBe('application/vnd.apple.mpegurl');
		expect(mimeByPath.get(SEGMENT_PATH)).toBe('video/mp2t');
		expect(mimeByPath.get(CMAF_PLAYLIST_PATH)).toBe('application/vnd.apple.mpegurl');
		expect(mimeByPath.get(CMAF_INIT_PATH)).toBe('video/mp4');
		expect(mimeByPath.get(CMAF_SEGMENT_PATH)).toBe('video/iso.segment');
	});

	test('archive page shows HLS preview', async ({ page, request, adminUser }) => {
		const { bucketName, filePath } = await uploadHlsTar(request, adminUser.token);

		// HLS tar ページは master.m3u8 を代表として直接プレビューする
		const segmentResponsePromise = page.waitForResponse(
			response => /\/segment-\d+-\d+\.(?:ts|m4s)(?:\?|$)/.test(response.url()),
			{ timeout: 20_000 },
		);
		await page.goto(`/v/${bucketName}/${filePath}`);
		await expect(page.getByText('ストリーミング再生')).toBeVisible();
		await expect(page.getByText(MASTER_PLAYLIST_PATH)).toBeVisible();

		// 広告ゲートが出たら通過する
		const proceedButton = page.getByRole('button', { name: 'ファイルに進む' });
		await proceedButton.click({ timeout: 10_000 }).catch(() => { /* 広告ゲートなし */ });

		// hls.js が master → メディアプレイリスト → セグメント と相対解決でフェッチする
		await expect(page.locator('video')).toBeVisible({ timeout: 15_000 });
		const segmentResponse = await segmentResponsePromise;
		expect(segmentResponse.status()).toBe(200);
		expect(['video/mp2t', 'video/iso.segment']).toContain(segmentResponse.headers()['content-type']);
	});

	test('uploader forces individual mode and stores HLS videos as tar entries', async ({ loggedInPage }) => {
		await loggedInPage.goto('/uploader');

		// ダミーの動画ファイルを選択 (変換はアップロード開始まで走らないので中身は不問)
		await loggedInPage.locator('input[type=file]').first().setInputFiles({
			name: 'movie.mp4',
			mimeType: 'video/mp4',
			buffer: Buffer.from('not-a-real-video'),
		});
		await expect(loggedInPage.getByText('movie.mp4').first()).toBeVisible();

		// メディア縮小設定で動画変換を有効にして HLS を選ぶ
		await loggedInPage.getByRole('button', { name: 'メディア縮小設定' }).click();
		const videoSection = loggedInPage.locator('section', { hasText: '動画' }).last();
		await videoSection.locator('input[type=checkbox]').check();
		const outputSelect = videoSection.locator('select').first();
		await expect(outputSelect.locator('option', { hasText: 'HLS' })).toHaveCount(1);
		await outputSelect.selectOption('application/vnd.apple.mpegurl');

		// HLS 選択でバリアント行リストに切り替わる
		const variantRows = loggedInPage.getByTestId('hls-variant-row');
		await expect(variantRows).toHaveCount(1);

		// CMAF 対応により AV1 / VP9 もバリアントのコーデックとして選択できる
		const firstRowCodecSelect = variantRows.first().locator('select');
		await expect(firstRowCodecSelect.locator('option')).toHaveText(['AVC', 'HEVC', 'AV1', 'VP9']);
		await firstRowCodecSelect.selectOption('av1');
		await variantRows.first().locator('input').nth(0).fill('1280');
		await variantRows.first().locator('input').nth(1).fill('720');
		await variantRows.first().locator('input').nth(2).fill('3.5');

		// バリアントの追加・削除。最後の1行は削除できない
		await loggedInPage.getByRole('button', { name: '+ バリアントを追加' }).click();
		await expect(variantRows).toHaveCount(2);
		await expect(variantRows.nth(1).locator('select')).toHaveValue('av1');
		await expect(variantRows.nth(1).locator('input').nth(0)).toHaveValue('854');
		await expect(variantRows.nth(1).locator('input').nth(1)).toHaveValue('480');
		await expect(variantRows.nth(1).locator('input').nth(2)).toHaveValue('1.75');
		await variantRows.nth(1).getByRole('button', { name: 'バリアント2を削除' }).click();
		await expect(variantRows).toHaveCount(1);
		await expect(variantRows.first().getByRole('button', { name: 'バリアント1を削除' })).toBeDisabled();

		await loggedInPage.getByRole('button', { name: '閉じる', exact: true }).last().click();
		await expect(loggedInPage.getByText('HLS', { exact: true })).toBeVisible();
		await expect(loggedInPage.getByText('AV1 3.5 Mbps 720p')).toBeVisible();

		// HLS 動画は動画ごとの単一 tar として個別アップロードされる
		await expect(loggedInPage.locator('input[type=radio][value=individual]')).toBeChecked();
		await expect(loggedInPage.locator('input[type=radio][value=individual]')).toBeEnabled();
		await expect(loggedInPage.locator('input[type=radio][value=gz]')).toBeDisabled();
		await expect(loggedInPage.locator('input[type=radio][value=tar]')).toBeDisabled();
		await expect(loggedInPage.locator('input[type=radio][value=targz]')).toBeDisabled();
		await expect(loggedInPage.getByText('HLS 変換された動画は、プレイリストとセグメントを単一の tar にまとめて個別アップロードします。')).toBeVisible();
	});
});
