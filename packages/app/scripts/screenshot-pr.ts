/**
 * スクリーンショット撮影スクリプト
 * SCENARIO env var でどのページを撮影するか指定する
 *   auth       - signin, signup ページ
 *   directory  - ディレクトリブラウズページ（バケット・ファイル作成込み）
 *   upload     - アップロードページ
 *   browse     - バケット閲覧ページ（公開バケット）
 *   passkeys   - パスキー管理ページ
 *   all        - 全部（デフォルト）
 *
 * Usage:
 *   BASE_URL=http://localhost:5173 SCENARIO=auth SCREENSHOTS_DIR=./screenshots npx tsx scripts/screenshot-pr.ts
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:5173';
const ADMIN_USERNAME = 'e2e_admin';
const ADMIN_PASSWORD = 'e2e_password_123';
const SCREENSHOTS_DIR = process.env['SCREENSHOTS_DIR'] ?? 'screenshots';
const SCENARIO = process.env['SCENARIO'] ?? 'all';

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

async function waitReady() {
	await page.waitForFunction(
		() => !document.querySelector('.page-loading'),
		{ timeout: 15_000 },
	);
}

async function shot(name: string, fullPage = true) {
	await page.waitForLoadState('networkidle').catch(() => {});
	const path = `${SCREENSHOTS_DIR}/${name}.png`;
	await page.screenshot({ path, fullPage });
	console.log(`Saved: ${path}`);
}

// 認証ヘルパー
async function signUp() {
	const res = await fetch(`${BASE_URL}/api/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
	});
	if (!res.ok && res.status !== 409) {
		const t = await res.text();
		console.warn(`signup failed (${res.status}): ${t}`);
	}
}

async function signIn(): Promise<string> {
	const res = await fetch(`${BASE_URL}/api/signin`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
	});
	if (!res.ok) throw new Error(`signin failed: ${res.status} ${await res.text()}`);
	const data = await res.json() as { token: string };
	return data.token;
}

async function setAuthToken(token: string) {
	await page.goto(BASE_URL);
	await page.evaluate((t) => localStorage.setItem('cfw_fileup_token', t), token);
	await page.reload();
	await waitReady();
}

// バケット作成 → bucketId を返す
async function createBucket(token: string, bucketName: string): Promise<string | null> {
	const res = await fetch(`${BASE_URL}/api/buckets/create`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ bucketName }),
	});
	if (!res.ok) {
		// 既存バケットの場合は list から取得
		const listRes = await fetch(`${BASE_URL}/api/buckets/list`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({}),
		});
		if (!listRes.ok) return null;
		const { buckets } = await listRes.json() as { buckets: Array<{ id: string; name: string }> };
		return buckets.find(b => b.name === bucketName)?.id ?? null;
	}
	const { bucketId } = await res.json() as { bucketId: string };
	return bucketId;
}

// テキストファイルをアップロード (open → PATCH → close)
async function uploadTestFile(token: string, bucketId: string, filePath: string, content: string) {
	const bytes = new TextEncoder().encode(content);

	// 1. open
	const openRes = await fetch(`${BASE_URL}/api/files/create/open`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ bucketId, path: filePath }),
	});
	if (!openRes.ok) {
		console.warn(`open failed for ${filePath}: ${openRes.status} ${await openRes.text()}`);
		return;
	}
	const { fileId } = await openRes.json() as { fileId: string };

	// 2. upload (PATCH /upload/:fileId/resume) — TUS protocol
	const uploadRes = await fetch(`${BASE_URL}/upload/${fileId}/resume`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/offset+octet-stream',
			'Upload-Offset': '0',
		},
		body: bytes,
	});
	if (!uploadRes.ok) {
		console.warn(`upload failed for ${filePath}: ${uploadRes.status} ${await uploadRes.text()}`);
		return;
	}

	// 3. close
	const closeRes = await fetch(`${BASE_URL}/api/files/create/close`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ fileId }),
	});
	if (!closeRes.ok) {
		console.warn(`close failed for ${filePath}: ${closeRes.status} ${await closeRes.text()}`);
	}
}

// --- メイン処理 ---

if (['auth', 'all'].includes(SCENARIO)) {
	console.log('--- Auth pages ---');
	await page.goto(`${BASE_URL}/signin`);
	await waitReady();
	await shot('signin');

	await page.goto(`${BASE_URL}/signup`);
	await waitReady();
	await shot('signup');
}

await signUp();
const token = await signIn();
await setAuthToken(token);

if (['upload', 'all'].includes(SCENARIO)) {
	console.log('--- Upload page ---');
	const uploadBucketName = 'e2e-screenshot-upload';
	await createBucket(token, uploadBucketName);
	await page.goto(`${BASE_URL}/my/buckets/${uploadBucketName}/upload`);
	await waitReady();
	await shot('upload');
}

if (['directory', 'all'].includes(SCENARIO)) {
	console.log('--- Directory page ---');
	const dirBucketName = 'e2e-screenshot-dir';
	const dirBucketId = await createBucket(token, dirBucketName);
	if (dirBucketId) {
		await uploadTestFile(token, dirBucketId, 'readme.txt', 'Hello World!\nThis is a test file.\n');
		await uploadTestFile(token, dirBucketId, 'docs/guide.md', '# Guide\nThis is the guide.\n');
		await uploadTestFile(token, dirBucketId, 'docs/api.md', '# API\nThis is the API docs.\n');
		await uploadTestFile(token, dirBucketId, 'images/photo.png', 'fake png data');
		await uploadTestFile(token, dirBucketId, 'images/banner.png', 'fake png data 2');
	}

	await page.goto(`${BASE_URL}/v/${dirBucketName}/`);
	await waitReady();
	await shot('directory-root');

	await page.goto(`${BASE_URL}/v/${dirBucketName}/docs/`);
	await waitReady();
	await shot('directory-sub');
}

if (['browse', 'all'].includes(SCENARIO)) {
	console.log('--- Browse page ---');
	const browseBucketName = 'e2e-screenshot-browse';
	const browseBucketId = await createBucket(token, browseBucketName);
	if (browseBucketId) {
		await uploadTestFile(token, browseBucketId, 'sample.txt', 'Sample file content\n');
	}
	await page.goto(`${BASE_URL}/v/${browseBucketName}/`);
	await waitReady();
	await shot('browse');
}

if (['passkeys', 'all'].includes(SCENARIO)) {
	console.log('--- Passkeys page ---');
	await page.goto(`${BASE_URL}/my/passkeys`);
	await waitReady();
	await shot('my-passkeys');
}

await browser.close();
console.log('Done.');
