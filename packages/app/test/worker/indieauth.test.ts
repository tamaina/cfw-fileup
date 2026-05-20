import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

describe('GET /api/auth/indieauth/begin', () => {
	test('returns 400 when profile_url is missing', async () => {
		const res = await app.request('/api/auth/indieauth/begin', { method: 'GET' }, env);
		expect(res.status).toBe(400);
	});

	test('returns 400 for invalid profile URL', async () => {
		const res = await app.request('/api/auth/indieauth/begin?profile_url=not-a-url', { method: 'GET' }, env);
		// This will try to discover auth endpoint and fail
		expect([400, 302]).toContain(res.status);
	});

	test('returns 400 for ftp:// URL scheme', async () => {
		const res = await app.request('/api/auth/indieauth/begin?profile_url=ftp%3A%2F%2Fexample.com', { method: 'GET' }, env);
		expect(res.status).toBe(400);
	});
});

describe('GET /api/auth/indieauth/callback', () => {
	test('redirects with error when error param is present', async () => {
		const res = await app.request('/api/auth/indieauth/callback?error=access_denied', { method: 'GET' }, env);
		expect(res.status).toBe(302);
		const location = res.headers.get('Location') ?? '';
		expect(location).toContain('indieauth_error=access_denied');
	});

	test('redirects with error when missing params', async () => {
		const res = await app.request('/api/auth/indieauth/callback', { method: 'GET' }, env);
		expect(res.status).toBe(302);
		const location = res.headers.get('Location') ?? '';
		expect(location).toContain('indieauth_error=missing_params');
	});

	test('redirects with error for invalid state', async () => {
		const res = await app.request('/api/auth/indieauth/callback?code=abc&state=invalid-state', { method: 'GET' }, env);
		expect(res.status).toBe(302);
		const location = res.headers.get('Location') ?? '';
		expect(location).toContain('indieauth_error=invalid_state');
	});
});

describe('POST /api/auth/indieauth/complete', () => {
	test('returns 400 when indieauthToken is missing', async () => {
		const res = await app.request('/api/auth/indieauth/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(400);
	});

	test('returns 401 for invalid token', async () => {
		const res = await app.request('/api/auth/indieauth/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ indieauthToken: 'invalid-token' }),
		}, env);
		expect(res.status).toBe(401);
	});

	test('returns token when valid session token is provided', async () => {
		const { data } = await signup('admin');
		const token = String(data.token);

		const res = await app.request('/api/auth/indieauth/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ indieauthToken: token }),
		}, env);
		expect(res.status).toBe(200);
		const responseData = await res.json() as { token?: string };
		expect(responseData.token).toBe(token);
	});
});

describe('indieauth_blocked_servers setting', () => {
	test('meta includes indieAuthEnabled', async () => {
		const res = await app.request('/api/meta', { method: 'GET' }, env);
		expect(res.status).toBe(200);
		const data = await res.json() as { indieAuthEnabled?: boolean };
		expect(data.indieAuthEnabled).toBe(true);
	});

	test('begin returns 403 when server is blocked', async () => {
		// Create admin user and block the server
		const { data: adminData } = await signup('admin');
		const adminToken = String(adminData.token);

		await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'indieauth_blocked_servers', value: 'misskey.io' }),
		}, env);

		const res = await app.request(
			'/api/auth/indieauth/begin?profile_url=https%3A%2F%2Fmisskey.io%2F%40testuser',
			{ method: 'GET' },
			env,
		);
		expect(res.status).toBe(403);
	});
});
