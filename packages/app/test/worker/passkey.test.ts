import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders, base64UrlToBytes } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function signupWithToken(username = 'user1') {
	const { data } = await signup(username);
	return {
		userId: String(data.userId),
		token: String(data.token),
	};
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes.at(i);
		if (byte == null) throw new Error('Expected byte to exist');
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

describe('POST /api/passkey/register/begin', () => {
	test('stores registration challenge as blob and can look it up from returned challenge', async () => {
		const { token } = await signupWithToken();

		const res = await app.request('/api/passkey/register/begin', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);

		expect(res.status).toBe(200);
		const body = await res.json() as {
			challengeId: string;
			options: { challenge: string };
		};

		const row = await env.DB
			.prepare('SELECT typeof(challenge) AS type, length(challenge) AS length FROM passkeys_challenges WHERE id = ? AND challenge = ?')
			.bind(body.challengeId, base64UrlToBytes(body.options.challenge))
			.first<{ type: string; length: number }>();

		expect(row?.type).toBe('blob');
		expect(row?.length).toBeGreaterThan(0);
	});

	test('encodes stored blob credential ids in excludeCredentials', async () => {
		const { userId, token } = await signupWithToken();
		const credentialId = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]);

		await env.DB.prepare(
			'INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
		)
			.bind('passkey1', userId, credentialId, new Uint8Array([5, 6, 7, 8]), JSON.stringify(['internal']), 'Laptop', Date.now())
			.run();

		const res = await app.request('/api/passkey/register/begin', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);

		expect(res.status).toBe(200);
		const body = await res.json() as {
			options: {
				excludeCredentials?: Array<{ id: string; transports?: string[] }>;
			};
		};

		expect(body.options.excludeCredentials).toContainEqual(expect.objectContaining({
			id: bytesToBase64Url(credentialId),
			transports: ['internal'],
		}));
	});
});

describe('POST /api/passkey/authenticate/begin', () => {
	test('stores authentication challenge as blob and can look it up from returned challenge', async () => {
		const res = await app.request('/api/passkey/authenticate/begin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		}, env);

		expect(res.status).toBe(200);
		const body = await res.json() as {
			challengeId: string;
			options: { challenge: string };
		};

		const row = await env.DB
			.prepare('SELECT typeof(challenge) AS type, length(challenge) AS length FROM passkeys_challenges WHERE id = ? AND challenge = ?')
			.bind(body.challengeId, base64UrlToBytes(body.options.challenge))
			.first<{ type: string; length: number }>();

		expect(row?.type).toBe('blob');
		expect(row?.length).toBeGreaterThan(0);
	});
});

describe('POST /api/passkey/backup-codes', () => {
	test('stores backup code hashes as blobs and uses a generated code once', async () => {
		const { userId, token } = await signupWithToken();

		const generateRes = await app.request('/api/passkey/backup-codes/generate', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);

		expect(generateRes.status).toBe(200);
		const generateBody = await generateRes.json() as { codes: string[] };
		expect(generateBody.codes).toHaveLength(10);

		const hashRow = await env.DB
			.prepare('SELECT typeof(code_hash) AS type, length(code_hash) AS length FROM backup_codes WHERE user_id = ? LIMIT 1')
			.bind(userId)
			.first<{ type: string; length: number }>();

		expect(hashRow).toEqual({ type: 'blob', length: 32 });

		const useRes = await app.request('/api/passkey/backup-codes/use', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				username: 'user1',
				password: 'password123',
				code: generateBody.codes[0]?.toLowerCase(),
			}),
		}, env);

		expect(useRes.status).toBe(200);
		const useBody = await useRes.json() as { token: string };

		const tokenBytes = base64UrlToBytes(useBody.token);
		const tokenDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', tokenBytes));
		const tokenRow = await env.DB
			.prepare('SELECT typeof(token) AS type, length(token) AS length FROM tokens WHERE token = ?')
			.bind(tokenDigest)
			.first<{ type: string; length: number }>();

		expect(tokenRow).toEqual({ type: 'blob', length: 32 });

		const reuseRes = await app.request('/api/passkey/backup-codes/use', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				username: 'user1',
				password: 'password123',
				code: generateBody.codes[0],
			}),
		}, env);

		expect(reuseRes.status).toBe(401);
	});
});
