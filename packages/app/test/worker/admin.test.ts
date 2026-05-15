import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, signin, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupAdminAndUser() {
	const { data: adminData } = await signup('admin');
	const { data: userData } = await signup('user1');
	return {
		adminToken: String(adminData.token),
		userToken: String(userData.token),
		userId: String(userData.userId),
	};
}

describe('Admin access control', () => {
	test('non-admin is denied all admin endpoints', async () => {
		await signup('admin');
		const { data } = await signup('user1');
		const userToken = String(data.token);

		const endpoints = [
			{ path: '/api/admin/suspend-user', body: { userId: 'x' } },
			{ path: '/api/admin/delete-file', body: { fileId: 'x' } },
			{ path: '/api/admin/delete-bucket', body: { bucketId: 'x' } },
			{ path: '/api/admin/toggle-registration', body: { enabled: false } },
		];

		for (const { path, body } of endpoints) {
			const res = await app.request(path, {
				method: 'POST',
				headers: authHeaders(userToken),
				body: JSON.stringify(body),
			}, env);
			expect(res.status).toBe(403);
		}
	});
});

describe('POST /api/admin/suspend-user', () => {
	test('admin can suspend a user', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		const res = await app.request('/api/admin/suspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(res.status).toBe(200);

		// Suspended user cannot sign in
		const { status } = await signin('user1', 'password123');
		expect(status).toBe(401);
	});

	test('nonexistent user returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/suspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/admin/delete-file', () => {
	test('admin can delete any file', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'test-bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketId, path: 'file.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/file.txt`, 'Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ fileId, isPublic: true }),
		}, env);

		const deleteRes = await app.request('/api/admin/delete-file', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ fileId }),
		}, env);
		expect(deleteRes.status).toBe(200);
	});

	test('nonexistent fileId returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/delete-file', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ fileId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/admin/delete-bucket', () => {
	test('admin can delete any bucket', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'test-bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const deleteRes = await app.request('/api/admin/delete-bucket', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ bucketId }),
		}, env);
		expect(deleteRes.status).toBe(200);
	});

	test('nonexistent bucketId returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/delete-bucket', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ bucketId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/admin/toggle-registration', () => {
	test('admin can disable registration', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/toggle-registration', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ enabled: false }),
		}, env);
		expect(res.status).toBe(200);

		// New user signup should fail
		const { status } = await signup('user3');
		expect(status).toBe(403);
	});

	test('admin can re-enable registration', async () => {
		const { adminToken } = await setupAdminAndUser();

		// Disable
		await app.request('/api/admin/toggle-registration', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ enabled: false }),
		}, env);

		// Re-enable
		await app.request('/api/admin/toggle-registration', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ enabled: true }),
		}, env);

		// New signup should succeed
		const { status } = await signup('user3');
		expect(status).toBe(200);
	});
});

describe('Quota management', () => {
	test('admin can set global quota', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/set-global-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ maxBuckets: 5, maxFilesPerBucket: 10 }),
		}, env);
		expect(res.status).toBe(200);

		const quotaRes = await app.request('/api/admin/get-global-quota', {
			method: 'GET',
			headers: authHeaders(adminToken),
		}, env);
		expect(quotaRes.status).toBe(200);
		const quota = await quotaRes.json() as Record<string, unknown>;
		expect(quota.maxBuckets).toBe(5);
		expect(quota.maxFilesPerBucket).toBe(10);
	});

	test('admin can set per-user quota', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		const res = await app.request(`/api/admin/set-user-quota/${userId}`, {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ maxBuckets: 3 }),
		}, env);
		expect(res.status).toBe(200);

		const quotaRes = await app.request(`/api/admin/get-user-quota/${userId}`, {
			method: 'GET',
			headers: authHeaders(adminToken),
		}, env);
		expect(quotaRes.status).toBe(200);
		const quota = await quotaRes.json() as Record<string, unknown>;
		expect(quota.maxBuckets).toBe(3);
	});

	test('global bucket quota enforced on create', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();

		await app.request('/api/admin/set-global-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ maxBuckets: 1 }),
		}, env);

		await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket-1' }),
		}, env);

		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket-2' }),
		}, env);
		expect(res.status).toBe(429);
	});

	test('admin can delete user quota', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		await app.request('/api/admin/set-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, maxBuckets: 2 }),
		}, env);

		const res = await app.request(`/api/admin/delete-user-quota/${userId}`, {
			method: 'POST',
			headers: authHeaders(adminToken),
		}, env);
		expect(res.status).toBe(200);
	});
});
