import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupUserAndBucket() {
	const { data } = await signup('user1');
	const token = String(data.token);

	const bucketRes = await app.request('/api/buckets/create', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketName: 'test_bucket' }),
	}, env);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	return { token, bucketId };
}

describe('POST /api/files/create/open', () => {
	test('creates file record and returns fileId + uploadExpiry', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(typeof body.fileId).toBe('string');
		expect(typeof body.uploadExpiry).toBe('number');
	});

	test('nonexistent bucket returns 404', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId: 'nonexistent', path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test("cannot create file in another user's bucket", async () => {
		const { bucketId } = await setupUserAndBucket();
		const { data: d2 } = await signup('user2');
		const t2 = String(d2.token);

		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(403);
	});

	test('duplicate closed file path returns 409', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Put data in R2 and close the file
		await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: true }),
		}, env);

		// Try to create the same path again
		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(409);
	});

	test('missing bucketId or path returns 400', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(400);
	});
});

describe('POST /api/files/create/targz-index', () => {
	test('registers targz index entries', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar.gz' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const res = await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [
					{
						path: 'file1.txt',
						mimeType: 'text/plain',
						aStart: 0,
						aFirstEnd: 512,
						aFinalStart: 512,
						aEnd: 512,
						rStartOffset: 0,
						rEndOffset: 0,
					},
				],
			}),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	test('nonexistent fileId returns 404', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId: 'nonexistent',
				files: [],
			}),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/files/create/close', () => {
	test('closes file after R2 upload', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Simulate upload to R2
		await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: true }),
		}, env);
		expect(closeRes.status).toBe(200);
		const body = await closeRes.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	test('returns 400 if R2 object not yet uploaded', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'missing.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: true }),
		}, env);
		expect(closeRes.status).toBe(400);
	});

	test('closes private file with passphrase', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: false, passphrase: 'mypassphrase' }),
		}, env);
		expect(closeRes.status).toBe(200);
	});
});

describe('POST /api/files/create/status', () => {
	test('returns partCount 0 and offset 0 before any parts are uploaded', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'upload.bin' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.partCount).toBe(0);
		expect(body.offset).toBe(0);
	});

	test('returns correct partCount and offset after a part is uploaded', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		// デフォルトのpartSizeは32MiB
		const DEFAULT_PART_SIZE = 32 * 1024 * 1024;

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'upload.bin' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Upload one small part (server counts parts, not bytes)
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		await app.request(`/upload/${fileId}/resume`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/offset+octet-stream',
				'Upload-Offset': '0',
				'Content-Length': String(data.length),
			},
			body: data.buffer,
		}, env);

		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.partCount).toBe(1);
		expect(body.offset).toBe(DEFAULT_PART_SIZE);
	});

	test('nonexistent fileId returns 404', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('unauthenticated access returns 401', async () => {
		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileId: 'some-id' }),
		}, env);
		expect(res.status).toBe(401);
	});

	test('missing fileId returns 400', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(400);
	});
});

describe('POST /api/files/delete', () => {
	test('owner can delete own file', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId: _ } = await openRes.json() as { fileId: string };
		void _;

		await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId: _, isPublic: true }),
		}, env);

		const deleteRes = await app.request('/api/files/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(deleteRes.status).toBe(200);
	});

	test("other user cannot delete another user's file", async () => {
		const { token, bucketId } = await setupUserAndBucket();
		const { data: d2 } = await signup('user2');
		const t2 = String(d2.token);

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };
		void fileId;

		await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: true }),
		}, env);

		const deleteRes = await app.request('/api/files/delete', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(deleteRes.status).toBe(403);
	});

	test('nonexistent file returns 404', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const res = await app.request('/api/files/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'nonexistent.txt' }),
		}, env);
		expect(res.status).toBe(404);
	});
});
