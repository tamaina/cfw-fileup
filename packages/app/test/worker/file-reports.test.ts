import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function createPublicFile(username: string, bucketName: string, path: string) {
	const { data } = await signup(username);
	const token = String(data.token);
	const userId = String(data.userId);

	const bucketRes = await app.request('/api/buckets/create', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketName }),
	}, env);
	expect(bucketRes.status).toBe(200);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	const openRes = await app.request('/api/files/create/open', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketId, path }),
	}, env);
	expect(openRes.status).toBe(200);
	const { fileId } = await openRes.json() as { fileId: string };

	await env.R2.put(fileId, `Content for ${path}`);
	const closeRes = await app.request('/api/files/create/close', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ fileId, visibility: 'public' }),
	}, env);
	expect(closeRes.status).toBe(200);

	return { token, userId, bucketId, fileId };
}

function fileReportBody(fileId: string) {
	return {
		fileId,
		reporterName: 'Reporter',
		reporterEmail: 'reporter@example.com',
		reasonId: 'copyright',
		relationshipId: 'rights_holder',
		contact: null,
		summary: '',
		detail: '',
	};
}

describe('POST /api/file-reports/create', () => {
	test('anonymous users can report a file', async () => {
		const { fileId } = await createPublicFile('owner', 'owner_bucket', 'hello.txt');

		const res = await app.request('/api/file-reports/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(fileReportBody(fileId)),
		}, env);

		expect(res.status).toBe(200);
		const body = await res.json() as { id: string };
		expect(typeof body.id).toBe('string');
	});

	test('logged-in users can report another user file and reporterUserId is recorded', async () => {
		const { token: adminToken, fileId } = await createPublicFile('owner', 'owner_bucket', 'hello.txt');
		const { data } = await signup('reporter');
		const reporterToken = String(data.token);
		const reporterUserId = String(data.userId);

		const createRes = await app.request('/api/file-reports/create', {
			method: 'POST',
			headers: authHeaders(reporterToken),
			body: JSON.stringify(fileReportBody(fileId)),
		}, env);
		expect(createRes.status).toBe(200);
		const created = await createRes.json() as { id: string };

		const detailRes = await app.request('/api/admin/get-file-report', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ reportId: created.id }),
		}, env);
		expect(detailRes.status).toBe(200);
		const detail = await detailRes.json() as { reporterUserId: string | null };
		expect(detail.reporterUserId).toBe(reporterUserId);
	});

	test('owners cannot report their own file', async () => {
		const { token, fileId } = await createPublicFile('owner', 'owner_bucket', 'hello.txt');

		const res = await app.request('/api/file-reports/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify(fileReportBody(fileId)),
		}, env);

		expect(res.status).toBe(403);
	});
});
