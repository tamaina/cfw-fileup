import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateToken, tokenToDigest } from '../../src/worker/utils/crypto';
import { env, app, setupDb, clearDb, signup, signin, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	vi.restoreAllMocks();
	await clearDb();
});

describe('POST /api/signup', () => {
	test('rate limited signup returns 429 before Turnstile verification', async () => {
		const limit = vi.fn(async () => ({ success: false }));
		const customEnv = Object.assign({}, env, {
			TURNSTILE_SECRET: 'secret',
			TURNSTILE_SITE_KEY: 'site-key',
			AUTH_RATE_LIMITER: { limit },
		});

		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'firstuser', password: 'password123' }),
		}, customEnv);

		expect(res.status).toBe(429);
		expect(await res.json()).toEqual(expect.objectContaining({ error: 'RATE_LIMITED' }));
		expect(limit).toHaveBeenCalledOnce();
	});

	test('first user becomes admin and returns userId + token', async () => {
		const { status, data } = await signup('firstuser');
		expect(status).toBe(200);
		expect(typeof data.userId).toBe('string');
		expect(typeof data.token).toBe('string');
	});

	test('second user is not admin (admin endpoint returns 403)', async () => {
		await signup('firstuser');
		const { data: d2 } = await signup('user2');
		const token = String(d2.token);

		const res = await app.request('/api/admin/get-global-quota', {
			method: 'GET',
			headers: authHeaders(token),
		}, env);
		expect(res.status).toBe(403);
	});

	test('duplicate username returns 409', async () => {
		await signup('firstuser');
		const { status } = await signup('firstuser');
		expect(status).toBe(409);
	});

	test('password shorter than 8 chars returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'user1', password: 'short' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('missing username returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: 'password123' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('missing password returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'user1' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('with SIGNUP_PASSPHRASE set: second user without passphrase returns 403', async () => {
		const customEnv = Object.assign({}, env, { SIGNUP_PASSPHRASE: 'secret' });
		await env.DB.prepare('UPDATE app_settings SET value = \'passphrase\' WHERE key = \'registration_mode\'').run();
		await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'firstuser', password: 'password123' }),
		}, customEnv);
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'user2', password: 'password123' }),
		}, customEnv);
		expect(res.status).toBe(403);
	});

	test('with SIGNUP_PASSPHRASE set: correct passphrase allows signup', async () => {
		const customEnv = Object.assign({}, env, { SIGNUP_PASSPHRASE: 'secret' });
		await env.DB.prepare('UPDATE app_settings SET value = \'passphrase\' WHERE key = \'registration_mode\'').run();
		await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'firstuser', password: 'password123' }),
		}, customEnv);
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'user2', password: 'password123', passphrase: 'secret' }),
		}, customEnv);
		expect(res.status).toBe(200);
	});

	test('when registration is disabled, second signup returns 403', async () => {
		const { data } = await signup('firstuser');
		const adminToken = String(data.token);

		await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'registration_mode', value: 'closed' }),
		}, env);

		const { status } = await signup('user2');
		expect(status).toBe(403);
	});

	test('username with invalid characters returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'user-name', password: 'password123' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('username with spaces returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'user name', password: 'password123' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('username with special characters returns 400', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'user@name', password: 'password123' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('valid username with alphanumeric and underscore succeeds', async () => {
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'valid_User_123', password: 'password123' }),
		}, env);
		expect(res.status).toBe(200);
	});

	test('forbidden username returns 400', async () => {
		await signup('firstuser');
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'admin', password: 'password123' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('case-insensitive duplicate username returns 409', async () => {
		await signup('MyUser');
		const res = await app.request('/api/signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'myuser', password: 'password123' }),
		}, env);
		expect(res.status).toBe(409);
	});
});

describe('POST /api/signin', () => {
	test('correct credentials returns token', async () => {
		await signup('user1');
		const { status, data } = await signin('user1', 'password123');
		expect(status).toBe(200);
		expect(typeof data.token).toBe('string');
	});

	test('wrong password returns 401', async () => {
		await signup('user1');
		const { status } = await signin('user1', 'wrongpassword');
		expect(status).toBe(401);
	});

	test('nonexistent user returns 401', async () => {
		const { status } = await signin('nobody', 'password123');
		expect(status).toBe(401);
	});

	test('suspended user returns 401', async () => {
		const { data: adminData } = await signup('firstuser');
		const { data: userData } = await signup('user1');
		const adminToken = String(adminData.token);
		const userId = String(userData.userId);

		await app.request('/api/admin/suspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);

		const { status } = await signin('user1', 'password123');
		expect(status).toBe(403);
	});

	test('unauthenticated request to protected endpoint returns 401', async () => {
		const res = await app.request('/api/buckets/list', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(401);
	});

	test('invalid token returns 401', async () => {
		const res = await app.request('/api/buckets/list', {
			method: 'POST',
			headers: authHeaders('invalidtoken'),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(401);
	});
});

describe('POST /api/account/update', () => {
	test('can update username with correct current password', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/account/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ currentPassword: 'password123', username: 'newname' }),
		}, env);
		expect(res.status).toBe(200);

		// Verify can sign in with new username
		const { status } = await signin('newname', 'password123');
		expect(status).toBe(200);
	});

	test('wrong current password returns 401', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/account/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ currentPassword: 'wrongpassword', username: 'newname' }),
		}, env);
		expect(res.status).toBe(401);
	});

	test('can update password', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/account/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ currentPassword: 'password123', newPassword: 'newpassword456' }),
		}, env);
		expect(res.status).toBe(200);

		// Verify can sign in with new password
		const { status } = await signin('user1', 'newpassword456');
		expect(status).toBe(200);
	});

	test('can set first password with recent WebAuthn bearer token', async () => {
		const token = generateToken();
		const tokenDigest = await tokenToDigest(token);
		expect(tokenDigest).not.toBeNull();
		await env.DB.prepare('INSERT INTO users (id, username, password_hash, is_admin, is_suspended) VALUES (?, ?, NULL, 0, 0)')
			.bind('passkey-user', 'passkeyuser')
			.run();
		await env.DB.prepare('INSERT INTO tokens (id, user_id, token, reauthenticated_at) VALUES (?, ?, ?, ?)')
			.bind('token1', 'passkey-user', tokenDigest, Date.now())
			.run();

		const res = await app.request('/api/account/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ newPassword: 'newpassword456' }),
		}, env);

		expect(res.status).toBe(200);
		const { status } = await signin('passkeyuser', 'newpassword456');
		expect(status).toBe(200);
	});

	test('cannot set first password without recent WebAuthn bearer token', async () => {
		const token = generateToken();
		const tokenDigest = await tokenToDigest(token);
		expect(tokenDigest).not.toBeNull();
		await env.DB.prepare('INSERT INTO users (id, username, password_hash, is_admin, is_suspended) VALUES (?, ?, NULL, 0, 0)')
			.bind('passkey-user', 'passkeyuser')
			.run();
		await env.DB.prepare('INSERT INTO tokens (id, user_id, token, reauthenticated_at) VALUES (?, ?, ?, ?)')
			.bind('token1', 'passkey-user', tokenDigest, Date.now() - 6 * 60 * 1000)
			.run();

		const res = await app.request('/api/account/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ newPassword: 'newpassword456' }),
		}, env);

		expect(res.status).toBe(400);
	});
});

describe('POST /api/account/wallets/link/begin authentication', () => {
	test('requires recent authentication or current password before SIWE challenge', async () => {
		const { data } = await signup('walletuser');
		const token = String(data.token);

		const res = await app.request('/api/account/wallets/link/begin', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				chainId: 8453,
				address: '0x3333333333333333333333333333333333333333',
			}),
		}, env);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual(expect.objectContaining({ error: 'CURRENT_PASSWORD_IS_REQUIRED' }));
	});

	test('rejects wrong current password before SIWE challenge', async () => {
		const { data } = await signup('walletuser');
		const token = String(data.token);

		const res = await app.request('/api/account/wallets/link/begin', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				chainId: 8453,
				address: '0x3333333333333333333333333333333333333333',
				currentPassword: 'wrongpassword',
			}),
		}, env);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual(expect.objectContaining({ error: 'INVALID_PASSWORD' }));
	});
});

describe('POST /api/account/email', () => {
	function mailEnv(sent: Array<{ to: string; raw: string }>): typeof env {
		return Object.assign({}, env, {
			MAIL_FROM: 'noreply@example.com',
			MAIL_MX_CHECK_DISABLED: 'true',
			PUBLIC_APP_URL: 'https://files.example.com',
			MAILER: {
				async send(message: { to: string; raw?: string }): Promise<void> {
					sent.push({ to: message.to, raw: message.raw ?? '' });
				},
			},
		});
	}

	async function waitForSent(sent: unknown[], count: number): Promise<void> {
		for (let i = 0; i < 20 && sent.length < count; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}

	function mockMxLookup(hasMx = true): void {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
			Status: hasMx ? 0 : 3,
			Answer: hasMx ? [{ type: 15, data: '10 mail.example.com.' }] : [],
		}), { status: 200, headers: { 'Content-Type': 'application/dns-json' } }));
	}

	test('stores verification token as blob and verifies the email', async () => {
		mockMxLookup();
		const sent: Array<{ to: string; raw: string }> = [];
		const customEnv = mailEnv(sent);
		const { data } = await signup('user1');
		const token = String(data.token);

		const updateRes = await app.request('/api/account/email/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ email: 'User@Gmail.com' }),
		}, customEnv);
		expect(updateRes.status).toBe(200);
		await waitForSent(sent, 1);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe('user@gmail.com');

		const row = await env.DB.prepare('SELECT token FROM email_verification_tokens').first<{ token: ArrayBuffer | number[] }>();
		expect(row?.token).not.toEqual(expect.any(String));
		const tokenLength = row?.token instanceof ArrayBuffer ? row.token.byteLength : row?.token.length;
		expect(tokenLength).toBe(32);
		const match = /email_verification_token=([^\s]+)/.exec(sent[0]?.raw ?? '');
		expect(match?.[1]).toBeTruthy();

		const verifyRes = await app.request('/api/account/email/verify', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ token: decodeURIComponent(match?.[1] ?? '') }),
		}, customEnv);
		expect(verifyRes.status).toBe(200);

		const meRes = await app.request('/api/account/me', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, customEnv);
		const me = await meRes.json() as { email: string | null; emailVerifiedAt: number | null };
		expect(me.email).toBe('user@gmail.com');
		expect(typeof me.emailVerifiedAt).toBe('number');
	});

	test('sends login notification only after email verification', async () => {
		mockMxLookup();
		const sent: Array<{ to: string; raw: string }> = [];
		const customEnv = mailEnv(sent);
		const { data } = await signup('user1');
		const token = String(data.token);

		await signin('user1', 'password123');
		await waitForSent(sent, 1);
		expect(sent).toHaveLength(0);

		await app.request('/api/account/email/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ email: 'user@gmail.com' }),
		}, customEnv);
		await waitForSent(sent, 1);
		const match = /email_verification_token=([^\s]+)/.exec(sent[0]?.raw ?? '');
		const verifyRes = await app.request('/api/account/email/verify', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ token: decodeURIComponent(match?.[1] ?? '') }),
		}, customEnv);
		expect(verifyRes.status).toBe(200);

		const signinRes = await app.request('/api/signin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'User-Agent': 'Vitest' },
			body: JSON.stringify({ username: 'user1', password: 'password123' }),
		}, customEnv);
		expect(signinRes.status).toBe(200);
		await waitForSent(sent, 2);
		expect(sent).toHaveLength(2);
		expect(sent[1]?.raw).toContain('新しいログイン');
		expect(sent[1]?.raw).toContain('Vitest');
	});

	test('requires Turnstile token for email verification when configured', async () => {
		mockMxLookup();
		const sent: Array<{ to: string; raw: string }> = [];
		const customEnv = Object.assign(mailEnv(sent), { TURNSTILE_SECRET: 'secret', TURNSTILE_SITE_KEY: 'site-key' });
		const { data } = await signup('user1');
		const token = String(data.token);

		await app.request('/api/account/email/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ email: 'user@gmail.com' }),
		}, customEnv);
		await waitForSent(sent, 1);
		const match = /email_verification_token=([^\s]+)/.exec(sent[0]?.raw ?? '');

		const verifyRes = await app.request('/api/account/email/verify', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ token: decodeURIComponent(match?.[1] ?? '') }),
		}, customEnv);
		expect(verifyRes.status).toBe(400);
		expect(await verifyRes.json()).toEqual(expect.objectContaining({ error: 'TURNSTILE_TOKEN_IS_REQUIRED' }));
	});

	test('rejects email updates when the recipient domain has no MX record', async () => {
		mockMxLookup(false);
		const sent: Array<{ to: string; raw: string }> = [];
		const customEnv = Object.assign(mailEnv(sent), { MAIL_MX_CHECK_DISABLED: '' });
		const { data } = await signup('user1');
		const token = String(data.token);

		const updateRes = await app.request('/api/account/email/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ email: 'user@example.com' }),
		}, customEnv);
		expect(updateRes.status).toBe(400);
		expect(await updateRes.json()).toEqual(expect.objectContaining({ error: 'EMAIL_DOMAIN_HAS_NO_MX' }));
		await waitForSent(sent, 1);
		expect(sent).toHaveLength(0);
	});

	test('rejects Null MX domains for email updates', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
			Status: 0,
			Answer: [{ type: 15, data: '0 .' }],
		}), { status: 200, headers: { 'Content-Type': 'application/dns-json' } }));
		const sent: Array<{ to: string; raw: string }> = [];
		const customEnv = Object.assign(mailEnv(sent), { MAIL_MX_CHECK_DISABLED: '' });
		const { data } = await signup('user1');
		const token = String(data.token);

		const updateRes = await app.request('/api/account/email/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ email: 'user@example.com' }),
		}, customEnv);
		expect(updateRes.status).toBe(400);
		expect(await updateRes.json()).toEqual(expect.objectContaining({ error: 'EMAIL_DOMAIN_HAS_NO_MX' }));
		expect(sent).toHaveLength(0);
	});

	test('rejects email updates when PUBLIC_APP_URL is missing', async () => {
		const sent: Array<{ to: string; raw: string }> = [];
		const customEnv = Object.assign(mailEnv(sent), { PUBLIC_APP_URL: '' });
		const { data } = await signup('user1');
		const token = String(data.token);

		const updateRes = await app.request('/api/account/email/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ email: 'user@gmail.com' }),
		}, customEnv);
		expect(updateRes.status).toBe(503);
		expect(await updateRes.json()).toEqual(expect.objectContaining({ error: 'PUBLIC_APP_URL_NOT_CONFIGURED' }));
		expect(sent).toHaveLength(0);
	});
});

describe('POST /api/account/agree-terms', () => {
	test('records terms agreement timestamp', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);
		const agreedAt = Date.now();

		const res = await app.request('/api/account/agree-terms', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ agreedAt }),
		}, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, termsAgreedAt: agreedAt });

		const meRes = await app.request('/api/account/me', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);
		expect(meRes.status).toBe(200);
		const me = await meRes.json() as { termsAgreedAt?: number | null };
		expect(me.termsAgreedAt).toBe(agreedAt);
	});
});

describe('POST /api/account/effective-quota', () => {
	test('returns current user effective quota', async () => {
		const { data: adminData } = await signup('firstuser');
		const { data: userData } = await signup('user1');
		const adminToken = String(adminData.token);
		const userToken = String(userData.token);
		const userId = String(userData.userId);

		await app.request('/api/admin/set-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, maxBuckets: 4 }),
		}, env);

		const res = await app.request('/api/account/effective-quota', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(200);
		const quota = await res.json() as Record<string, unknown>;
		expect(quota.maxBuckets).toBe(4);
		expect(quota.effectiveQuotaSource).toBe('custom');
	});
});
