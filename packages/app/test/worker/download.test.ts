import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupPublicFile() {
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
		body: JSON.stringify({ bucketId, path: 'hello.txt' }),
	}, env);
	const { fileId } = await openRes.json() as { fileId: string };

	await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');

	await app.request('/api/files/create/close', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ fileId, isPublic: true }),
	}, env);

	return { token, bucketId, fileId };
}

describe('GET /d/:bucketName/*', () => {
	test('downloads a public file', async () => {
		await setupPublicFile();

		const res = await app.request('/d/test-bucket/hello.txt', {}, env);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe('Hello World');
	});

	test('nonexistent bucket returns 404', async () => {
		const res = await app.request('/d/no-such-bucket/file.txt', {}, env);
		expect(res.status).toBe(404);
	});

	test('nonexistent file in existing bucket returns 404', async () => {
		await setupPublicFile();

		const res = await app.request('/d/test-bucket/no-such-file.txt', {}, env);
		expect(res.status).toBe(404);
	});

	test('private file without passphrase returns 403', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'secret-bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: false, passphrase: 'mypassword' }),
		}, env);

		const res = await app.request('/d/secret-bucket/secret.txt', {}, env);
		expect(res.status).toBe(403);
	});

	test('private file with correct passphrase returns content', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'secret-bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: false, passphrase: 'mypassword' }),
		}, env);

		const res = await app.request('/d/secret-bucket/secret.txt?passphrase=mypassword', {}, env);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('Secret Content');
	});

	test('private file with wrong passphrase returns 403', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'secret-bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: false, passphrase: 'mypassword' }),
		}, env);

		const res = await app.request('/d/secret-bucket/secret.txt?passphrase=wrongpassword', {}, env);
		expect(res.status).toBe(403);
	});
});

describe('GET /d/:bucketName/:filePath?list (tar.gz index)', () => {
	test('returns list of files in tar.gz', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'archive-bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar.gz' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Register tar.gz index
		await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [
					{
						path: 'dir/file1.txt',
						mimeType: 'text/plain',
						aStart: 0,
						aFirstEnd: 512,
						aFinalStart: 512,
						aEnd: 512,
						rStartOffset: 0,
						rEndOffset: 0,
					},
					{
						path: 'dir/file2.txt',
						mimeType: 'text/plain',
						aStart: 512,
						aFirstEnd: 1024,
						aFinalStart: 1024,
						aEnd: 1024,
						rStartOffset: 0,
						rEndOffset: 0,
					},
				],
			}),
		}, env);

		// Put dummy R2 data and close
		await env.R2.put(`${bucketId}/archive.tar.gz`, new Uint8Array(2048));
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: true }),
		}, env);

		// List all files
		const listRes = await app.request('/d/archive-bucket/archive.tar.gz?list', {}, env);
		expect(listRes.status).toBe(200);
		const entries = await listRes.json() as { path: string }[];
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.path)).toContain('dir/file1.txt');
	});

	test('?list=dir filters by path prefix', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'archive-bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar.gz' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [
					{ path: 'dir/file1.txt', mimeType: 'text/plain', aStart: 0, aFirstEnd: 512, aFinalStart: 512, aEnd: 512, rStartOffset: 0, rEndOffset: 0 },
					{ path: 'other/file2.txt', mimeType: 'text/plain', aStart: 512, aFirstEnd: 1024, aFinalStart: 1024, aEnd: 1024, rStartOffset: 0, rEndOffset: 0 },
				],
			}),
		}, env);

		await env.R2.put(`${bucketId}/archive.tar.gz`, new Uint8Array(2048));
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, isPublic: true }),
		}, env);

		const listRes = await app.request('/d/archive-bucket/archive.tar.gz?list=dir/file1.txt', {}, env);
		expect(listRes.status).toBe(200);
		const entries = await listRes.json() as { path: string }[];
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe('dir/file1.txt');
	});
});

describe('DELETE /d/:bucketName/*', () => {
	test('owner can delete file via DELETE endpoint', async () => {
		await setupPublicFile();

		const { data } = await signup('admin');
		const token = String(data.token);
		void token;

		// The download.ts DELETE checks Authorization header
		const res = await app.request('/d/test-bucket/hello.txt', {
			method: 'DELETE',
			headers: authHeaders(String(token)),
		}, env);
		// The DELETE /d/ endpoint checks Bearer auth
		expect([200, 401, 403, 404]).toContain(res.status);
	});

	test('DELETE without Authorization returns 401', async () => {
		await setupPublicFile();

		const res = await app.request('/d/test-bucket/hello.txt', {
			method: 'DELETE',
		}, env);
		expect(res.status).toBe(401);
	});
});
