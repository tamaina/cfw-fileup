import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

afterEach(() => {
	vi.restoreAllMocks();
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

	test('redirects to Misskey OAuth authorization endpoint discovered from well-known metadata', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url === 'https://p1.a9z.dev/.well-known/oauth-authorization-server') {
				return Response.json({
					issuer: 'https://p1.a9z.dev',
					authorization_endpoint: 'https://p1.a9z.dev/oauth/authorize',
					token_endpoint: 'https://p1.a9z.dev/oauth/token',
					response_types_supported: ['code'],
					grant_types_supported: ['authorization_code'],
					code_challenge_methods_supported: ['S256'],
				});
			}
			return new Response('not found', { status: 404 });
		});

		const res = await app.request(
			'http://localhost:8788/api/auth/indieauth/begin?profile_url=https%3A%2F%2Fp1.a9z.dev%2F%40aqz',
			{ method: 'GET' },
			env,
		);
		expect(res.status).toBe(302);

		const location = res.headers.get('Location');
		expect(location).toBeTruthy();
		const url = new URL(location ?? '');
		expect(url.origin + url.pathname).toBe('https://p1.a9z.dev/oauth/authorize');
		expect(url.searchParams.get('client_id')).toBe('http://localhost:8788/api/auth/indieauth/client');
		expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8788/api/auth/indieauth/callback');
		expect(url.searchParams.get('scope')).toBe('read:account');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBeTruthy();
	});

	test('stores signup data in OAuth state', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url === 'https://p1.a9z.dev/.well-known/oauth-authorization-server') {
				return Response.json({
					issuer: 'https://p1.a9z.dev',
					authorization_endpoint: 'https://p1.a9z.dev/oauth/authorize',
					token_endpoint: 'https://p1.a9z.dev/oauth/token',
				});
			}
			return new Response('not found', { status: 404 });
		});

		const res = await app.request(
			'http://localhost:8788/api/auth/indieauth/begin?profile_url=https%3A%2F%2Fp1.a9z.dev%2F%40aqz&passphrase=secret&username=alice',
			{ method: 'GET' },
			env,
		);
		expect(res.status).toBe(302);

		const location = res.headers.get('Location') ?? '';
		const state = new URL(location).searchParams.get('state');
		expect(state).toBeTruthy();

		const row = await env.DB
			.prepare('SELECT signup_passphrase, signup_username FROM oauth_states WHERE state = ?')
			.bind(state)
			.first<{ signup_passphrase: string | null; signup_username: string | null }>();
		expect(row?.signup_passphrase).toBe('secret');
		expect(row?.signup_username).toBe('alice');
	});
});

describe('GET /api/auth/indieauth/client', () => {
	test('serves OAuth client metadata page for Misskey client discovery', async () => {
		const res = await app.request('http://localhost:8788/api/auth/indieauth/client', { method: 'GET' }, env);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('<link rel="redirect_uri" href="http://localhost:8788/api/auth/indieauth/callback">');
		expect(html).toContain('class="h-app"');
		expect(html).toContain('CFW FileUp');
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
