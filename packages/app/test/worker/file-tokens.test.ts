import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

// ---- helpers ----------------------------------------------------------------

async function setupUserAndBucket(username = 'user1') {
	const { data } = await signup(username);
	const token = String(data.token);
	const res = await app.request('/api/buckets/create', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketName: `${username}_bucket` }),
	}, env);
	const { bucketId } = await res.json() as { bucketId: string };
	return { token, bucketId, bucketName: `${username}_bucket` };
}

async function createClosedFile(
	token: string,
	bucketId: string,
	bucketName: string,
	path: string,
	opts: { isPublic?: boolean; passphrase?: string } = {},
) {
	const openRes = await app.request('/api/files/create/open', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketId, path }),
	}, env);
	const { fileId } = await openRes.json() as { fileId: string };
	await env.R2.put(`${bucketId}/${path}`, 'content');
	const closeBody: Record<string, unknown> = { fileId, isPublic: opts.isPublic ?? false };
	if (opts.passphrase !== undefined) closeBody.passphrase = opts.passphrase;
	await app.request('/api/files/create/close', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify(closeBody),
	}, env);
	return { fileId, path };
}

// ---- POST /api/file-tokens/create ------------------------------------------

describe('POST /api/file-tokens/create', () => {
	test('returns id, token, expiresAt for private file', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt');

		const res = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', expiresIn: 3600 }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(typeof body.id).toBe('string');
		expect(typeof body.token).toBe('string');
		expect(typeof body.expiresAt).toBe('number');
	});

	test('expiresIn null returns expiresAt null', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt');

		const res = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', expiresIn: null }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.expiresAt).toBeNull();
	});

	test('expiresIn <= 0 returns 400', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt');

		const res = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', expiresIn: -1 }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('nonexistent bucket returns 404', async () => {
		const { token } = await setupUserAndBucket();

		const res = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'no_bucket', filePath: 'file.txt', expiresIn: 3600 }),
		}, env);
		expect(res.status).toBe(404);
	});

	test("other user's bucket returns 403", async () => {
		const { token: t1, bucketId: b1, bucketName: bn1 } = await setupUserAndBucket('user1');
		await createClosedFile(t1, b1, bn1, 'secret.txt');
		const { token: t2 } = await setupUserAndBucket('user2');

		const res = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ bucketName: bn1, filePath: 'secret.txt', expiresIn: 3600 }),
		}, env);
		expect(res.status).toBe(403);
	});

	test('nonexistent file returns 404', async () => {
		const { token, bucketName } = await setupUserAndBucket();

		const res = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'missing.txt', expiresIn: 3600 }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('public file returns 400', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'public.txt', { isPublic: true });

		const res = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'public.txt', expiresIn: 3600 }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('unauthenticated returns 401', async () => {
		const res = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName: 'b', filePath: 'f.txt', expiresIn: 3600 }),
		}, env);
		expect(res.status).toBe(401);
	});
});

// ---- POST /api/file-tokens/list --------------------------------------------

describe('POST /api/file-tokens/list', () => {
	test('returns empty array when no tokens exist', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt');

		const res = await app.request('/api/file-tokens/list', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'secret.txt' }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as { tokens: unknown[] };
		expect(body.tokens).toHaveLength(0);
	});

	test('returns created tokens with id, expiresAt, createdAt', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt');
		await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', expiresIn: 3600 }),
		}, env);

		const res = await app.request('/api/file-tokens/list', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'secret.txt' }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as { tokens: Array<{ id: string; expiresAt: number; createdAt: number }> };
		expect(body.tokens).toHaveLength(1);
		expect(typeof body.tokens[0].id).toBe('string');
		expect(typeof body.tokens[0].expiresAt).toBe('number');
		expect(typeof body.tokens[0].createdAt).toBe('number');
	});

	test("other user's bucket returns 403", async () => {
		const { token: t1, bucketId: b1, bucketName: bn1 } = await setupUserAndBucket('user1');
		await createClosedFile(t1, b1, bn1, 'secret.txt');
		const { token: t2 } = await setupUserAndBucket('user2');

		const res = await app.request('/api/file-tokens/list', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ bucketName: bn1, filePath: 'secret.txt' }),
		}, env);
		expect(res.status).toBe(403);
	});

	test('nonexistent bucket returns 404', async () => {
		const { token } = await setupUserAndBucket();

		const res = await app.request('/api/file-tokens/list', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'no_bucket', filePath: 'file.txt' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('unauthenticated returns 401', async () => {
		const res = await app.request('/api/file-tokens/list', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName: 'b', filePath: 'f.txt' }),
		}, env);
		expect(res.status).toBe(401);
	});
});

// ---- POST /api/file-tokens/delete ------------------------------------------

describe('POST /api/file-tokens/delete', () => {
	test('deletes token and returns ok', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt');
		const createRes = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', expiresIn: 3600 }),
		}, env);
		const { id: tokenId } = await createRes.json() as { id: string };

		const res = await app.request('/api/file-tokens/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ tokenId }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test('nonexistent token returns 404', async () => {
		const { token } = await setupUserAndBucket();

		const res = await app.request('/api/file-tokens/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ tokenId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test("other user cannot delete another user's token", async () => {
		const { token: t1, bucketId: b1, bucketName: bn1 } = await setupUserAndBucket('user1');
		await createClosedFile(t1, b1, bn1, 'secret.txt');
		const createRes = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(t1),
			body: JSON.stringify({ bucketName: bn1, filePath: 'secret.txt', expiresIn: 3600 }),
		}, env);
		const { id: tokenId } = await createRes.json() as { id: string };

		const { token: t2 } = await setupUserAndBucket('user2');
		const res = await app.request('/api/file-tokens/delete', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ tokenId }),
		}, env);
		expect(res.status).toBe(403);
	});

	test('unauthenticated returns 401', async () => {
		const res = await app.request('/api/file-tokens/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tokenId: 'x' }),
		}, env);
		expect(res.status).toBe(401);
	});
});

// ---- POST /api/file-tokens/create-by-passphrase ----------------------------

describe('POST /api/file-tokens/create-by-passphrase', () => {
	test('correct passphrase returns id, token, expiresAt', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt', { passphrase: 'hunter2' });

		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', passphrase: 'hunter2' }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(typeof body.id).toBe('string');
		expect(typeof body.token).toBe('string');
		expect(typeof body.expiresAt).toBe('number');
	});

	test('wrong passphrase returns 403', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt', { passphrase: 'hunter2' });

		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', passphrase: 'wrong' }),
		}, env);
		expect(res.status).toBe(403);
	});

	test('file with no passphrase set returns 403', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt');

		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', passphrase: 'anything' }),
		}, env);
		expect(res.status).toBe(403);
	});

	test('public file returns 400', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'public.txt', { isPublic: true });

		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName, filePath: 'public.txt', passphrase: 'any' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('nonexistent bucket returns 404', async () => {
		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName: 'no_bucket', filePath: 'file.txt', passphrase: 'pw' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('nonexistent file returns 404', async () => {
		const { bucketName } = await setupUserAndBucket();

		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName, filePath: 'missing.txt', passphrase: 'pw' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('Turnstile enabled: missing turnstileToken returns 400', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt', { passphrase: 'hunter2' });
		const customEnv = Object.assign({}, env, { TURNSTILE_SECRET: 'secret' });

		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', passphrase: 'hunter2' }),
		}, customEnv);
		expect(res.status).toBe(400);
	});

	test('Turnstile enabled: failed verification returns 400', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt', { passphrase: 'hunter2' });
		const customEnv = Object.assign({}, env, { TURNSTILE_SECRET: 'secret' });

		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			json: () => Promise.resolve({ success: false }),
		}));

		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', passphrase: 'hunter2', turnstileToken: 'bad' }),
		}, customEnv);
		expect(res.status).toBe(400);

		vi.unstubAllGlobals();
	});

	test('Turnstile enabled: passed verification returns 200', async () => {
		const { token, bucketId, bucketName } = await setupUserAndBucket();
		await createClosedFile(token, bucketId, bucketName, 'secret.txt', { passphrase: 'hunter2' });
		const customEnv = Object.assign({}, env, { TURNSTILE_SECRET: 'secret' });

		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			json: () => Promise.resolve({ success: true }),
		}));

		const res = await app.request('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName, filePath: 'secret.txt', passphrase: 'hunter2', turnstileToken: 'good' }),
		}, customEnv);
		expect(res.status).toBe(200);

		vi.unstubAllGlobals();
	});
});
