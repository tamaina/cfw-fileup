import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

describe('POST /api/buckets/create', () => {
	test('creates bucket and returns bucketId', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'my-bucket' }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(typeof body.bucketId).toBe('string');
	});

	test('duplicate bucket name returns 409', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'my-bucket' }),
		}, env);

		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'my-bucket' }),
		}, env);
		expect(res.status).toBe(409);
	});

	test('without auth returns 401', async () => {
		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bucketName: 'my-bucket' }),
		}, env);
		expect(res.status).toBe(401);
	});

	test('missing bucketName returns 400', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(400);
	});
});

describe('POST /api/buckets/list', () => {
	test('returns only own buckets', async () => {
		const { data: d1 } = await signup('user1');
		const { data: d2 } = await signup('user2');
		const t1 = String(d1.token);
		const t2 = String(d2.token);

		await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(t1),
			body: JSON.stringify({ bucketName: 'bucket-a' }),
		}, env);
		await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ bucketName: 'bucket-b' }),
		}, env);

		const res = await app.request('/api/buckets/list', {
			method: 'POST',
			headers: authHeaders(t1),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as { buckets: { name: string }[] };
		expect(body.buckets).toHaveLength(1);
		expect(body.buckets[0].name).toBe('bucket-a');
	});

	test('returns empty list when user has no buckets', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/buckets/list', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as { buckets: unknown[] };
		expect(body.buckets).toHaveLength(0);
	});
});

describe('POST /api/buckets/delete', () => {
	test('owner can delete own bucket', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const createRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'my-bucket' }),
		}, env);
		const { bucketId } = await createRes.json() as { bucketId: string };

		const deleteRes = await app.request('/api/buckets/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId }),
		}, env);
		expect(deleteRes.status).toBe(200);

		// Verify bucket is gone
		const listRes = await app.request('/api/buckets/list', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);
		const { buckets } = await listRes.json() as { buckets: unknown[] };
		expect(buckets).toHaveLength(0);
	});

	test("other user cannot delete another user's bucket (403)", async () => {
		const { data: d1 } = await signup('admin');
		const { data: d2 } = await signup('user2');
		const t1 = String(d1.token);
		const t2 = String(d2.token);

		const createRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(t1),
			body: JSON.stringify({ bucketName: 'my-bucket' }),
		}, env);
		const { bucketId } = await createRes.json() as { bucketId: string };

		const deleteRes = await app.request('/api/buckets/delete', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ bucketId }),
		}, env);
		expect(deleteRes.status).toBe(403);
	});

	test('nonexistent bucketId returns 404', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/buckets/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('admin can delete any bucket', async () => {
		const { data: adminData } = await signup('admin');
		const { data: userData } = await signup('user1');
		const adminToken = String(adminData.token);
		const userToken = String(userData.token);

		const createRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'user-bucket' }),
		}, env);
		const { bucketId } = await createRes.json() as { bucketId: string };

		const deleteRes = await app.request('/api/buckets/delete', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ bucketId }),
		}, env);
		expect(deleteRes.status).toBe(200);
	});
});
