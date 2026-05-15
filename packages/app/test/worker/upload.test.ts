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

describe('GET /upload/:fileId/resume', () => {
	test('returns 200 with Upload-Offset: 0 before upload', async () => {
		const { token, fileId } = await setupFileForUpload();

		const res = await app.request(`/upload/${fileId}/resume`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
		}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Upload-Offset')).toBe('0');
		expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
	});

	test('nonexistent fileId returns 404', async () => {
		const { token } = await setupFileForUpload();

		const res = await app.request('/upload/nonexistent/resume', {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('PATCH /upload/:fileId/resume', () => {
	test('missing Upload-Offset header returns 400', async () => {
		const { token, fileId } = await setupFileForUpload();
		const data = new Uint8Array([1, 2, 3]);

		const res = await app.request(`/upload/${fileId}/resume`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/offset+octet-stream',
				'Content-Length': String(data.length),
			},
			body: data.buffer,
		}, env);
		expect(res.status).toBe(400);
	});

	test('nonexistent fileId returns 404', async () => {
		const { token } = await setupFileForUpload();
		const data = new Uint8Array([1, 2, 3]);

		const res = await app.request('/upload/nonexistent/resume', {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Upload-Offset': '0',
				'Content-Type': 'application/offset+octet-stream',
				'Content-Length': String(data.length),
			},
			body: data.buffer,
		}, env);
		expect(res.status).toBe(404);
	});

	test('first PATCH creates multipart upload and returns 204 with new offset', async () => {
		const { token, fileId } = await setupFileForUpload();
		const data = new Uint8Array([1, 2, 3, 4, 5]);

		const res = await app.request(`/upload/${fileId}/resume`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Upload-Offset': '0',
				'Content-Type': 'application/offset+octet-stream',
				'Content-Length': String(data.length),
			},
			body: data.buffer,
		}, env);
		expect(res.status).toBe(204);
		expect(res.headers.get('Upload-Offset')).toBe(String(data.length));
		expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
	});

	test('invalid Upload-Offset returns 400', async () => {
		const { token, fileId } = await setupFileForUpload();
		const data = new Uint8Array([1]);

		const res = await app.request(`/upload/${fileId}/resume`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Upload-Offset': 'notanumber',
				'Content-Type': 'application/offset+octet-stream',
				'Content-Length': String(data.length),
			},
			body: data.buffer,
		}, env);
		expect(res.status).toBe(400);
	});
});
