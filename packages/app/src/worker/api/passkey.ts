import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, lt } from 'drizzle-orm';
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { passkeys, passkeysChallenges, backupCodes, tokens, users } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { genEaidx, parseEaidx } from '../../shared/eaid-x';
import { generateToken } from '../utils/crypto';
import { isValidNameFormat } from '../../shared/name-validation';
import type {
	AuthenticatorTransportFuture,
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from '@simplewebauthn/server';

const app = new Hono<{ Bindings: Env }>();

/** Encode Uint8Array to base64 string (standard base64) */
function uint8ArrayToBase64(arr: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < arr.length; i++) {
		// arr[i] is always defined since i < arr.length
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		binary += String.fromCharCode(arr[i]!);
	}
	return btoa(binary);
}

/** Decode base64 string to Uint8Array<ArrayBuffer> */
function base64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const buf = new ArrayBuffer(binary.length);
	const arr = new Uint8Array(buf);
	for (let i = 0; i < binary.length; i++) {
		arr[i] = binary.charCodeAt(i);
	}
	return arr;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10; // characters

/** Derive rpID and origin from the incoming request URL */
function getRpInfo(reqUrl: string): { rpID: string; origin: string } {
	const url = new URL(reqUrl);
	const rpID = url.hostname;
	const origin = url.origin;
	return { rpID, origin };
}

/** Clean up expired challenges (best-effort, non-blocking) */
function cleanupExpiredChallenges(db: ReturnType<typeof getDb>): void {
	const now = Date.now();
	db.delete(passkeysChallenges).where(lt(passkeysChallenges.expiresAt, now)).run().catch(() => {});
}

/** Generate a random alphanumeric backup code */
function generateBackupCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = new Uint8Array(BACKUP_CODE_LENGTH);
	crypto.getRandomValues(bytes);
	return Array.from(bytes).map((b) => chars[b % chars.length]).join('');
}

/** Hash a backup code using SHA-256 */
async function hashBackupCode(code: string): Promise<string> {
	const data = new TextEncoder().encode(code);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return uint8ArrayToBase64(new Uint8Array(hashBuffer));
}

// ─── Register begin (requires auth) ────────────────────────────────────────

app.post('/register/begin', authMiddleware, async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const { rpID } = getRpInfo(c.req.url);

	const existingPasskeys = await db
		.select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
		.from(passkeys)
		.where(eq(passkeys.userId, user.id));

	const options = await generateRegistrationOptions({
		rpName: 'CFW FileUp',
		rpID,
		userName: user.username,
		userDisplayName: user.username,
		attestationType: 'none',
		excludeCredentials: existingPasskeys.map((pk) => ({
			id: pk.credentialId,
			transports: pk.transports
				? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
				: undefined,
		})),
		authenticatorSelection: {
			residentKey: 'preferred',
			userVerification: 'preferred',
		},
	});

	const challengeId = genEaidx(Date.now());
	await db.insert(passkeysChallenges).values({
		id: challengeId,
		challenge: options.challenge,
		userId: user.id,
		type: 'register',
		expiresAt: Date.now() + CHALLENGE_TTL_MS,
	});

	cleanupExpiredChallenges(db);

	return c.json({ challengeId, options });
});

// ─── Register finish (requires auth) ───────────────────────────────────────

app.post('/register/finish', authMiddleware, async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const { rpID, origin } = getRpInfo(c.req.url);

	const body = (await c.req.json()) as {
		challengeId?: string;
		credential?: RegistrationResponseJSON;
		name?: string;
	};

	if (!body.challengeId || !body.credential) {
		throw new HTTPException(400, { message: 'challengeId and credential are required' });
	}

	const now = Date.now();
	const challengeRecord = await db
		.select()
		.from(passkeysChallenges)
		.where(
			and(
				eq(passkeysChallenges.id, body.challengeId),
				eq(passkeysChallenges.userId, user.id),
				eq(passkeysChallenges.type, 'register'),
			),
		)
		.get();

	if (!challengeRecord || challengeRecord.expiresAt < now) {
		throw new HTTPException(400, { message: 'Invalid or expired challenge' });
	}

	await db.delete(passkeysChallenges).where(eq(passkeysChallenges.id, body.challengeId));

	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response: body.credential,
			expectedChallenge: challengeRecord.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
		});
	} catch (e) {
		throw new HTTPException(400, { message: `Verification failed: ${String(e)}` });
	}

	if (!verification.verified) {
		throw new HTTPException(400, { message: 'Verification failed' });
	}

	const { credential } = verification.registrationInfo;

	const passkeyId = genEaidx(Date.now());
	await db.insert(passkeys).values({
		id: passkeyId,
		userId: user.id,
		credentialId: credential.id,
		publicKey: uint8ArrayToBase64(credential.publicKey),
		counter: credential.counter,
		transports: body.credential.response.transports
			? JSON.stringify(body.credential.response.transports)
			: null,
		name: body.name?.trim() ?? null,
		createdAt: parseEaidx(passkeyId).date.getTime(),
	});

	return c.json({ ok: true });
});

// ─── Authenticate begin (no auth required) ─────────────────────────────────

app.post('/authenticate/begin', async (c) => {
	const db = getDb(c.env);
	const { rpID } = getRpInfo(c.req.url);

	const options = await generateAuthenticationOptions({
		rpID,
		userVerification: 'preferred',
		allowCredentials: [],
	});

	const challengeId = genEaidx(Date.now());
	await db.insert(passkeysChallenges).values({
		id: challengeId,
		challenge: options.challenge,
		userId: null,
		type: 'authenticate',
		expiresAt: Date.now() + CHALLENGE_TTL_MS,
	});

	cleanupExpiredChallenges(db);

	return c.json({ challengeId, options });
});

// ─── Authenticate finish (no auth required) ────────────────────────────────

app.post('/authenticate/finish', async (c) => {
	const db = getDb(c.env);
	const { rpID, origin } = getRpInfo(c.req.url);

	const body = (await c.req.json()) as { challengeId?: string; credential?: AuthenticationResponseJSON };

	if (!body.challengeId || !body.credential) {
		throw new HTTPException(400, { message: 'challengeId and credential are required' });
	}

	const now = Date.now();
	const challengeRecord = await db
		.select()
		.from(passkeysChallenges)
		.where(
			and(
				eq(passkeysChallenges.id, body.challengeId),
				eq(passkeysChallenges.type, 'authenticate'),
			),
		)
		.get();

	if (!challengeRecord || challengeRecord.expiresAt < now) {
		throw new HTTPException(400, { message: 'Invalid or expired challenge' });
	}

	await db.delete(passkeysChallenges).where(eq(passkeysChallenges.id, body.challengeId));

	const passkeyRecord = await db
		.select()
		.from(passkeys)
		.where(eq(passkeys.credentialId, body.credential.id))
		.get();

	if (!passkeyRecord) {
		throw new HTTPException(401, { message: 'Passkey not found' });
	}

	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response: body.credential,
			expectedChallenge: challengeRecord.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			credential: {
				id: passkeyRecord.credentialId,
				publicKey: base64ToUint8Array(passkeyRecord.publicKey),
				counter: passkeyRecord.counter,
				transports: passkeyRecord.transports
					? (JSON.parse(passkeyRecord.transports) as AuthenticatorTransportFuture[])
					: undefined,
			},
		});
	} catch (e) {
		throw new HTTPException(401, { message: `Authentication failed: ${String(e)}` });
	}

	if (!verification.verified) {
		throw new HTTPException(401, { message: 'Authentication failed' });
	}

	await db
		.update(passkeys)
		.set({ counter: verification.authenticationInfo.newCounter })
		.where(eq(passkeys.id, passkeyRecord.id));

	const user = await db.select().from(users).where(eq(users.id, passkeyRecord.userId)).get();
	if (!user) {
		throw new HTTPException(401, { message: 'User not found' });
	}

	if (user.isSuspended) {
		throw new HTTPException(401, { message: 'Account is suspended' });
	}

	const tokenId = genEaidx(Date.now());
	const tokenValue = generateToken();
	await db.insert(tokens).values({
		id: tokenId,
		userId: user.id,
		token: tokenValue,
	});

	return c.json({ token: tokenValue });
});

// ─── List passkeys (requires auth) ─────────────────────────────────────────

app.get('/list', authMiddleware, async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');

	const userPasskeys = await db
		.select({
			id: passkeys.id,
			name: passkeys.name,
			createdAt: passkeys.createdAt,
		})
		.from(passkeys)
		.where(eq(passkeys.userId, user.id));

	return c.json(userPasskeys);
});

// ─── Delete passkey (requires auth) ────────────────────────────────────────

app.delete('/:passkeyId', authMiddleware, async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const { passkeyId } = c.req.param();

	const passkeyRecord = await db
		.select()
		.from(passkeys)
		.where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, user.id)))
		.get();

	if (!passkeyRecord) {
		throw new HTTPException(404, { message: 'Passkey not found' });
	}

	await db.delete(passkeys).where(eq(passkeys.id, passkeyId));

	return c.json({ ok: true });
});

// ─── Generate backup codes (requires auth) ──────────────────────────────────

app.post('/backup-codes/generate', authMiddleware, async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');

	// Delete existing unused backup codes and generate new ones
	await db.delete(backupCodes).where(eq(backupCodes.userId, user.id));

	const codes: string[] = [];
	for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
		const code = generateBackupCode();
		codes.push(code);
		const codeHash = await hashBackupCode(code);
		const codeId = genEaidx(Date.now() + i);
		await db.insert(backupCodes).values({
			id: codeId,
			userId: user.id,
			codeHash,
			usedAt: null,
			createdAt: Date.now(),
		});
	}

	return c.json({ codes });
});

// ─── Get backup code status (requires auth) ────────────────────────────────

app.get('/backup-codes/status', authMiddleware, async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');

	const userCodes = await db
		.select({ id: backupCodes.id, usedAt: backupCodes.usedAt, createdAt: backupCodes.createdAt })
		.from(backupCodes)
		.where(eq(backupCodes.userId, user.id));

	return c.json({
		count: userCodes.length,
		remaining: userCodes.filter((c) => c.usedAt === null).length,
	});
});

// ─── Login with backup code (no auth required) ─────────────────────────────

app.post('/backup-codes/use', async (c) => {
	const db = getDb(c.env);

	const body = (await c.req.json()) as { username?: string; code?: string };
	if (!body.username || !body.code) {
		throw new HTTPException(400, { message: 'username and code are required' });
	}

	const user = await db
		.select()
		.from(users)
		.where(eq(users.username, body.username))
		.get();

	if (!user) {
		throw new HTTPException(401, { message: 'Invalid username or code' });
	}

	if (user.isSuspended) {
		throw new HTTPException(401, { message: 'Account is suspended' });
	}

	const codeHash = await hashBackupCode(body.code.toUpperCase().replace(/\s/g, ''));

	const codeRecord = await db
		.select()
		.from(backupCodes)
		.where(
			and(
				eq(backupCodes.userId, user.id),
				eq(backupCodes.codeHash, codeHash),
			),
		)
		.get();

	if (!codeRecord || codeRecord.usedAt !== null) {
		throw new HTTPException(401, { message: 'Invalid username or code' });
	}

	// Mark code as used
	await db
		.update(backupCodes)
		.set({ usedAt: Date.now() })
		.where(eq(backupCodes.id, codeRecord.id));

	const tokenId = genEaidx(Date.now());
	const tokenValue = generateToken();
	await db.insert(tokens).values({
		id: tokenId,
		userId: user.id,
		token: tokenValue,
	});

	return c.json({ token: tokenValue });
});

// ─── Passkey signup begin (no auth required) ────────────────────────────────

app.post('/signup/begin', async (c) => {
	const db = getDb(c.env);
	const { rpID } = getRpInfo(c.req.url);

	const body = (await c.req.json()) as { username?: string };
	if (!body.username) {
		throw new HTTPException(400, { message: 'username is required' });
	}

	const username = body.username.trim();
	if (!isValidNameFormat(username)) {
		throw new HTTPException(400, { message: 'Invalid username format' });
	}

	// Check username availability
	const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
	if (existing) {
		throw new HTTPException(409, { message: 'Username already taken' });
	}

	// Generate registration options with a synthetic user ID (not stored yet)
	const tempUserId = genEaidx(Date.now());
	const options = await generateRegistrationOptions({
		rpName: 'CFW FileUp',
		rpID,
		userName: username,
		userDisplayName: username,
		attestationType: 'none',
		excludeCredentials: [],
		authenticatorSelection: {
			residentKey: 'preferred',
			userVerification: 'preferred',
		},
	});

	const challengeId = genEaidx(Date.now());
	// Store challenge with type 'signup' and encode username in userId field (prefixed)
	await db.insert(passkeysChallenges).values({
		id: challengeId,
		challenge: options.challenge,
		userId: `signup:${tempUserId}:${username}`,
		type: 'signup',
		expiresAt: Date.now() + CHALLENGE_TTL_MS,
	});

	cleanupExpiredChallenges(db);

	return c.json({ challengeId, options });
});

// ─── Passkey signup finish (no auth required) ───────────────────────────────

app.post('/signup/finish', async (c) => {
	const db = getDb(c.env);
	const { rpID, origin } = getRpInfo(c.req.url);

	const body = (await c.req.json()) as {
		challengeId?: string;
		credential?: RegistrationResponseJSON;
		passkeyName?: string;
	};

	if (!body.challengeId || !body.credential) {
		throw new HTTPException(400, { message: 'challengeId and credential are required' });
	}

	const now = Date.now();
	const challengeRecord = await db
		.select()
		.from(passkeysChallenges)
		.where(
			and(
				eq(passkeysChallenges.id, body.challengeId),
				eq(passkeysChallenges.type, 'signup'),
			),
		)
		.get();

	if (!challengeRecord || challengeRecord.expiresAt < now) {
		throw new HTTPException(400, { message: 'Invalid or expired challenge' });
	}

	// Parse username from the userId field
	const parts = challengeRecord.userId?.split(':') ?? [];
	if (parts.length < 3 || parts[0] !== 'signup') {
		throw new HTTPException(400, { message: 'Invalid challenge data' });
	}
	const username = parts.slice(2).join(':');

	await db.delete(passkeysChallenges).where(eq(passkeysChallenges.id, body.challengeId));

	// Double-check username still available
	const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
	if (existing) {
		throw new HTTPException(409, { message: 'Username already taken' });
	}

	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response: body.credential,
			expectedChallenge: challengeRecord.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
		});
	} catch (e) {
		throw new HTTPException(400, { message: `Verification failed: ${String(e)}` });
	}

	if (!verification.verified) {
		throw new HTTPException(400, { message: 'Verification failed' });
	}

	const { credential } = verification.registrationInfo;

	// Create user (no password)
	const userId = genEaidx(Date.now());
	await db.insert(users).values({
		id: userId,
		username,
		passwordHash: null,
		isSuspended: false,
	});

	// Store passkey
	const passkeyId = genEaidx(Date.now());
	await db.insert(passkeys).values({
		id: passkeyId,
		userId,
		credentialId: credential.id,
		publicKey: uint8ArrayToBase64(credential.publicKey),
		counter: credential.counter,
		transports: body.credential.response.transports
			? JSON.stringify(body.credential.response.transports)
			: null,
		name: body.passkeyName?.trim() ?? null,
		createdAt: parseEaidx(passkeyId).date.getTime(),
	});

	// Issue token
	const tokenId = genEaidx(Date.now());
	const tokenValue = generateToken();
	await db.insert(tokens).values({
		id: tokenId,
		userId,
		token: tokenValue,
	});

	return c.json({ token: tokenValue });
});

export const passkeyRoutes = app;
