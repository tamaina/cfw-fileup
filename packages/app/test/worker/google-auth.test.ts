import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, signin, authHeaders, base64UrlToBytes } from './helpers';

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

const noGoogleEnv = Object.assign({}, env, {
	GOOGLE_CLIENT_ID: '',
	GOOGLE_CLIENT_SECRET: '',
	GOOGLE_REDIRECT_URI: '',
});

const undefinedGoogleEnv = Object.assign({}, env, {
	GOOGLE_CLIENT_ID: undefined,
	GOOGLE_CLIENT_SECRET: undefined,
	GOOGLE_REDIRECT_URI: undefined,
});

describe('GET /api/auth/google', () => {
	test('returns 503 when Google OAuth is not configured', async () => {
		const res = await app.request('/api/auth/google', { method: 'GET' }, noGoogleEnv);
		expect(res.status).toBe(503);
	});

	test('returns 503 when Google OAuth env vars are undefined', async () => {
		const res = await app.request('/api/auth/google', { method: 'GET' }, undefinedGoogleEnv);
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

	test('stores signup data in OAuth state', async () => {
		const res = await app.request('/api/auth/google?passphrase=secret&username=alice', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(302);

		const location = res.headers.get('Location') ?? '';
		const state = new URL(location).searchParams.get('state');
		expect(state).toBeTruthy();

		const row = await env.DB
			.prepare('SELECT signup_passphrase, signup_username FROM oauth_states WHERE state = ?')
			.bind(base64UrlToBytes(state ?? ''))
			.first<{ signup_passphrase: string | null; signup_username: string | null }>();
		expect(row?.signup_passphrase).toBe('secret');
		expect(row?.signup_username).toBe('alice');
	});
});

describe('POST /api/account/link/google/begin', () => {
	test('requires current password', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/account/link/google/begin', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ currentPassword: 'wrongpassword' }),
		}, googleEnv);
		expect(res.status).toBe(401);
	});

	test('stores current user id in OAuth state', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);
		const userId = String(data.userId);

		const res = await app.request('/api/account/link/google/begin', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ currentPassword: 'password123' }),
		}, googleEnv);
		expect(res.status).toBe(200);

		const body = await res.json() as { url: string };
		const state = new URL(body.url).searchParams.get('state');
		expect(state).toBeTruthy();

		const row = await env.DB
			.prepare('SELECT link_user_id FROM oauth_states WHERE state = ?')
			.bind(base64UrlToBytes(state ?? ''))
			.first<{ link_user_id: string | null }>();
		expect(row?.link_user_id).toBe(userId);
	});
});

describe('GET /api/auth/google/callback', () => {
	test('returns 503 when Google OAuth is not configured', async () => {
		const res = await app.request('/api/auth/google/callback?code=abc&state=xyz', { method: 'GET' }, noGoogleEnv);
		expect(res.status).toBe(503);
	});

	test('redirects with error when state is missing', async () => {
		const res = await app.request('/api/auth/google/callback?code=abc', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toContain('google_error=missing_params');
	});

	test('redirects with error when code is missing', async () => {
		const res = await app.request('/api/auth/google/callback?state=xyz', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toContain('google_error=missing_params');
	});

	test('redirects with error for invalid/expired state', async () => {
		const res = await app.request('/api/auth/google/callback?code=abc&state=invalid-state', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toContain('google_error=invalid_state');
	});

	test('redirects with error parameter', async () => {
		const res = await app.request('/api/auth/google/callback?error=access_denied', { method: 'GET' }, googleEnv);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toContain('google_error=access_denied');
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
