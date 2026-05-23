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

describe('POST /api/directories/create', () => {
	test('creates directory with valid unicode path', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const res = await app.request('/api/directories/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: '親/子/' }),
		}, env);
		expect(res.status).toBe(200);
	});

	test('invalid directory name returns 400', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const res = await app.request('/api/directories/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'bad:name/' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('forbidden bucket name as directory segment returns 400', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const res = await app.request('/api/directories/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'admin/' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('directory path that conflicts with a file returns 409', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'docs' }),
		}, env);
		expect(openRes.status).toBe(200);

		const res = await app.request('/api/directories/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'docs/' }),
		}, env);
		expect(res.status).toBe(409);
	});
});
