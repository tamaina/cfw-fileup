import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, signin, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

describe('POST /api/signup', () => {
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

		await app.request('/api/admin/toggle-registration', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ enabled: false }),
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
		expect(status).toBe(401);
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
});
