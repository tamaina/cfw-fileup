import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupFileForUpload() {
	const { data } = await signup('user1');
	const token = String(data.token);

	const bucketRes = await app.request('/api/buckets/create', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketName: 'test-bucket' }),
	}, env);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	const openRes = await app.request('/api/files/create/open', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketId, path: 'upload-test.bin' }),
	}, env);
	const { fileId } = await openRes.json() as { fileId: string };

	return { token, bucketId, fileId };
}

describe('HEAD /upload/:fileId', () => {
	test('returns 200 with Upload-Offset: 0 before upload', async () => {
		const { fileId } = await setupFileForUpload();

		const res = await app.request(`/upload/${fileId}`, {
			method: 'HEAD',
		}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Upload-Offset')).toBe('0');
		expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
	});

	test('nonexistent fileId returns 404', async () => {
		const res = await app.request('/upload/nonexistent', {
			method: 'HEAD',
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('PATCH /upload/:fileId', () => {
	test('missing Upload-Offset header returns 400', async () => {
		const { fileId } = await setupFileForUpload();

		const res = await app.request(`/upload/${fileId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/offset+octet-stream' },
			body: new Uint8Array([1, 2, 3]).buffer,
		}, env);
		expect(res.status).toBe(400);
	});

	test('nonexistent fileId returns 404', async () => {
		const res = await app.request('/upload/nonexistent', {
			method: 'PATCH',
			headers: {
				'Upload-Offset': '0',
				'Content-Type': 'application/offset+octet-stream',
			},
			body: new Uint8Array([1, 2, 3]).buffer,
		}, env);
		expect(res.status).toBe(404);
	});

	test('first PATCH creates multipart upload and returns 204 with new offset', async () => {
		const { fileId } = await setupFileForUpload();
		const data = new Uint8Array([1, 2, 3, 4, 5]);

		const res = await app.request(`/upload/${fileId}`, {
			method: 'PATCH',
			headers: {
				'Upload-Offset': '0',
				'Content-Type': 'application/offset+octet-stream',
			},
			body: data.buffer,
		}, env);
		expect(res.status).toBe(204);
		expect(res.headers.get('Upload-Offset')).toBe(String(data.length));
		expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
	});

	test('invalid Upload-Offset returns 400', async () => {
		const { fileId } = await setupFileForUpload();

		const res = await app.request(`/upload/${fileId}`, {
			method: 'PATCH',
			headers: {
				'Upload-Offset': 'notanumber',
				'Content-Type': 'application/offset+octet-stream',
			},
			body: new Uint8Array([1]).buffer,
		}, env);
		expect(res.status).toBe(400);
	});
});
