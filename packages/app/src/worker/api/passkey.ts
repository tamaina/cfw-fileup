import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, lt } from 'drizzle-orm';
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { passkeys, passkeysChallenges, tokens, users } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { genEaidx, parseEaidx } from '../../shared/eaid-x';
import { generateToken } from '../utils/crypto';
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
	// fire-and-forget
	db.delete(passkeysChallenges).where(lt(passkeysChallenges.expiresAt, now)).run().catch(() => {});
}

// ─── Register begin (requires auth) ────────────────────────────────────────

app.post('/register/begin', authMiddleware, async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const { rpID } = getRpInfo(c.req.url);

	// Get existing credentials for excludeCredentials
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

	// Store challenge in DB
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

	const body = (await c.req.json()) as { challengeId?: string; credential?: RegistrationResponseJSON };

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

	// Delete used challenge
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

	// Store passkey
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
		allowCredentials: [], // allow any registered credential
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

	// Delete used challenge
	await db.delete(passkeysChallenges).where(eq(passkeysChallenges.id, body.challengeId));

	// Find passkey by credential ID
	const passkeyRecord = await db
		.select()
		.from(passkeys)
		.where(eq(passkeys.credentialId, body.credential.id))
		.get();

	if (!passkeyRecord) {
		throw new HTTPException(401, { message: 'Passkey not found' });
	}

	// Verify
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

	// Update counter
	await db
		.update(passkeys)
		.set({ counter: verification.authenticationInfo.newCounter })
		.where(eq(passkeys.id, passkeyRecord.id));

	// Check user
	const user = await db.select().from(users).where(eq(users.id, passkeyRecord.userId)).get();
	if (!user) {
		throw new HTTPException(401, { message: 'User not found' });
	}

	if (user.isSuspended) {
		throw new HTTPException(401, { message: 'Account is suspended' });
	}

	// Issue token
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
			credentialId: passkeys.credentialId,
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

export const passkeyRoutes = app;
