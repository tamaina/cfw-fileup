import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, signin, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

const googleEnv = Object.assign({}, env, {
	GOOGLE_CLIENT_ID: 'test-client-id',
	GOOGLE_CLIENT_SECRET: 'test-client-secret',
	GOOGLE_REDIRECT_URI: 'http://localhost:8788/api/auth/google/callback',
});

describe('GET /api/auth/google', () => {
	test('returns 503 when Google OAuth is not configured', async () => {
		const res = await app.request('/api/auth/google', { method: 'GET' }, env);
		expect(res.status).toBe(503);
	});

	test('redirects to Google auth URL when configured', async () => {
		const res = await app.request('/api/auth/google', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(302);
		const location = res.headers.get('Location') ?? '';
		expect(location).toContain('accounts.google.com');
		expect(location).toContain('client_id=test-client-id');
		expect(location).toContain('state=');
	});
});

describe('GET /api/auth/google/callback', () => {
	test('returns 503 when Google OAuth is not configured', async () => {
		const res = await app.request('/api/auth/google/callback?code=abc&state=xyz', { method: 'GET' }, env);
		expect(res.status).toBe(503);
	});

	test('returns 400 when state is missing', async () => {
		const res = await app.request('/api/auth/google/callback?code=abc', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(400);
	});

	test('returns 400 when code is missing', async () => {
		const res = await app.request('/api/auth/google/callback?state=xyz', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(400);
	});

	test('returns 400 for invalid/expired state', async () => {
		const res = await app.request('/api/auth/google/callback?code=abc&state=invalid-state', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(400);
	});

	test('returns 400 with error parameter', async () => {
		const res = await app.request('/api/auth/google/callback?error=access_denied', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(400);
	});
});

describe('POST /api/auth/google/complete', () => {
	test('returns 400 when googleToken is missing', async () => {
		const res = await app.request('/api/auth/google/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(400);
	});

	test('returns 401 for invalid token', async () => {
		const res = await app.request('/api/auth/google/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ googleToken: 'invalid-token' }),
		}, env);
		expect(res.status).toBe(401);
	});

	test('returns token when valid session token is provided', async () => {
		// Create a user and get a token
		const { data } = await signup('admin');
		const token = String(data.token);

		// The complete endpoint validates that the token exists in DB
		const res = await app.request('/api/auth/google/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ googleToken: token }),
		}, env);
		expect(res.status).toBe(200);
		const responseData = await res.json() as { token?: string };
		expect(responseData.token).toBe(token);
	});
});

describe('google_required setting', () => {
	test('signup with password fails when google_required is enabled', async () => {
		// First user creates admin
		const { data: adminData } = await signup('admin');
		const adminToken = String(adminData.token);

		// Enable google_required
		await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'google_required', value: 'true' }),
		}, env);

		// Try to signup with password - should fail
		const { status } = await signup('user2');
		expect(status).toBe(403);
	});

	test('signin with password fails when google_required is enabled', async () => {
		// First user creates admin
		const { data: adminData } = await signup('admin');
		const adminToken = String(adminData.token);

		// Enable google_required
		await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'google_required', value: 'true' }),
		}, env);

		// Try to sign in with password - should fail
		const { status } = await signin('admin', 'password123');
		expect(status).toBe(403);
	});

	test('meta includes googleAuthEnabled and googleRequired', async () => {
		const res = await app.request('/api/meta', { method: 'GET' }, env);
		expect(res.status).toBe(200);
		const data = await res.json() as { googleAuthEnabled?: boolean; googleRequired?: boolean };
		expect(typeof data.googleAuthEnabled).toBe('boolean');
		expect(typeof data.googleRequired).toBe('boolean');
	});
});
