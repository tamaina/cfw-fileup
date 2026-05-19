import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, and, lt, count } from 'drizzle-orm';
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { passkeys, passkeysChallenges, backupCodes, tokens, users, appSettings, usedUsernames } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { genEaidx, parseEaidx } from '../../shared/eaid-x';
import { generateToken, verifyPassword } from '../utils/crypto';
import { isValidNameFormat } from '../../shared/name-validation';
import { validateUsername } from '../utils/name-validation';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';

const app = new Hono<{ Bindings: Env }>();

/** Encode Uint8Array to base64 string (standard base64) */
function uint8ArrayToBase64(arr: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < arr.length; i++) {
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

function stringToUserId(value: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(value);
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10; // characters

/** Derive rpID and origin from the incoming request URL */
function getRpInfo(reqUrl: string): { rpID: string; origin: string } {
	const url = new URL(reqUrl);
	return { rpID: url.hostname, origin: url.origin };
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

app.post(
	'/register/begin',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/passkey/register/begin'])),
	validator('json', apiDef['/api/passkey/register/begin'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/register/begin', Env>) => {
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
			userID: stringToUserId(user.id),
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

		return c.json({ challengeId, options }, 200);
	}, getResponseDefWithAuth('/api/passkey/register/begin')),
);

// ─── Register finish (requires auth) ───────────────────────────────────────

app.post(
	'/register/finish',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/passkey/register/finish'])),
	validator('json', apiDef['/api/passkey/register/finish'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/register/finish', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const { rpID, origin } = getRpInfo(c.req.url);
		const body = c.req.valid('json');
		const credential = body.credential;

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
				response: credential,
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

		const { credential: cred } = verification.registrationInfo;

		const passkeyId = genEaidx(Date.now());
		await db.insert(passkeys).values({
			id: passkeyId,
			userId: user.id,
			credentialId: cred.id,
			publicKey: uint8ArrayToBase64(cred.publicKey),
			counter: cred.counter,
			transports: credential.response.transports
				? JSON.stringify(credential.response.transports)
				: null,
			name: body.name?.trim() ?? null,
			createdAt: parseEaidx(passkeyId).date.getTime(),
		});

		return c.json({ ok: true as const }, 200);
	}, getResponseDefWithAuth('/api/passkey/register/finish')),
);

// ─── Authenticate begin ─────────────────────────────────────────────────────

app.post(
	'/authenticate/begin',
	describeRoute(omitResAndReq(apiDef['/api/passkey/authenticate/begin'])),
	validator('json', apiDef['/api/passkey/authenticate/begin'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/authenticate/begin', Env>) => {
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

		return c.json({ challengeId, options }, 200);
	}, apiDef['/api/passkey/authenticate/begin'].res),
);

// ─── Authenticate finish ────────────────────────────────────────────────────

app.post(
	'/authenticate/finish',
	describeRoute(omitResAndReq(apiDef['/api/passkey/authenticate/finish'])),
	validator('json', apiDef['/api/passkey/authenticate/finish'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/authenticate/finish', Env>) => {
		const db = getDb(c.env);
		const { rpID, origin } = getRpInfo(c.req.url);
		const body = c.req.valid('json');
		const credential = body.credential;

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
			.where(eq(passkeys.credentialId, credential.id))
			.get();

		if (!passkeyRecord) {
			throw new HTTPException(401, { message: 'Passkey not found' });
		}

		let verification;
		try {
			verification = await verifyAuthenticationResponse({
				response: credential,
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
		await db.insert(tokens).values({ id: tokenId, userId: user.id, token: tokenValue });

		return c.json({ token: tokenValue }, 200);
	}, apiDef['/api/passkey/authenticate/finish'].res),
);

// ─── List passkeys (requires auth) ─────────────────────────────────────────

app.post(
	'/list',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/passkey/list'])),
	validator('json', apiDef['/api/passkey/list'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/list', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');

		const userPasskeys = await db
			.select({ id: passkeys.id, name: passkeys.name, createdAt: passkeys.createdAt })
			.from(passkeys)
			.where(eq(passkeys.userId, user.id));

		return c.json(userPasskeys, 200);
	}, getResponseDefWithAuth('/api/passkey/list')),
);

// ─── Delete passkey (requires auth) ────────────────────────────────────────

app.post(
	'/delete',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/passkey/delete'])),
	validator('json', apiDef['/api/passkey/delete'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/delete', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const { passkeyId } = c.req.valid('json');

		const passkeyRecord = await db
			.select()
			.from(passkeys)
			.where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, user.id)))
			.get();

		if (!passkeyRecord) {
			throw new HTTPException(404, { message: 'Passkey not found' });
		}

		await db.delete(passkeys).where(eq(passkeys.id, passkeyId));

		return c.json({ ok: true as const }, 200);
	}, getResponseDefWithAuth('/api/passkey/delete')),
);

// ─── Generate backup codes (requires auth) ──────────────────────────────────

app.post(
	'/backup-codes/generate',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/passkey/backup-codes/generate'])),
	validator('json', apiDef['/api/passkey/backup-codes/generate'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/backup-codes/generate', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');

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

		return c.json({ codes }, 200);
	}, getResponseDefWithAuth('/api/passkey/backup-codes/generate')),
);

// ─── Get backup code status (requires auth) ────────────────────────────────

app.post(
	'/backup-codes/status',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/passkey/backup-codes/status'])),
	validator('json', apiDef['/api/passkey/backup-codes/status'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/backup-codes/status', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');

		const userCodes = await db
			.select({ id: backupCodes.id, usedAt: backupCodes.usedAt })
			.from(backupCodes)
			.where(eq(backupCodes.userId, user.id));

		return c.json({
			count: userCodes.length,
			remaining: userCodes.filter((code) => code.usedAt === null).length,
		}, 200);
	}, getResponseDefWithAuth('/api/passkey/backup-codes/status')),
);

// ─── Login with backup code ─────────────────────────────────────────────────

app.post(
	'/backup-codes/use',
	describeRoute(omitResAndReq(apiDef['/api/passkey/backup-codes/use'])),
	validator('json', apiDef['/api/passkey/backup-codes/use'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/backup-codes/use', Env>) => {
		const db = getDb(c.env);
		const { username, password, code } = c.req.valid('json');

		const user = await db.select().from(users).where(eq(users.username, username)).get();
		if (!user) {
			throw new HTTPException(401, { message: 'Invalid credentials or code' });
		}
		if (user.isSuspended) {
			throw new HTTPException(401, { message: 'Account is suspended' });
		}
		if (!user.passwordHash) {
			throw new HTTPException(401, { message: 'Invalid credentials or code' });
		}
		const passwordValid = await verifyPassword(password, user.passwordHash);
		if (!passwordValid) {
			throw new HTTPException(401, { message: 'Invalid credentials or code' });
		}

		const codeHash = await hashBackupCode(code.toUpperCase().replace(/[\s-]/g, ''));

		const codeRecord = await db
			.select()
			.from(backupCodes)
			.where(and(eq(backupCodes.userId, user.id), eq(backupCodes.codeHash, codeHash)))
			.get();

		if (!codeRecord || codeRecord.usedAt !== null) {
			throw new HTTPException(401, { message: 'Invalid credentials or code' });
		}

		await db.update(backupCodes).set({ usedAt: Date.now() }).where(eq(backupCodes.id, codeRecord.id));

		const tokenId = genEaidx(Date.now());
		const tokenValue = generateToken();
		await db.insert(tokens).values({ id: tokenId, userId: user.id, token: tokenValue });

		return c.json({ token: tokenValue }, 200);
	}, apiDef['/api/passkey/backup-codes/use'].res),
);

// ─── Passkey signup begin ───────────────────────────────────────────────────

app.post(
	'/signup/begin',
	describeRoute(omitResAndReq(apiDef['/api/passkey/signup/begin'])),
	validator('json', apiDef['/api/passkey/signup/begin'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/signup/begin', Env>) => {
		const db = getDb(c.env);
		const { rpID } = getRpInfo(c.req.url);
		const { username, passphrase } = c.req.valid('json');
		const trimmed = username.trim();

		if (!isValidNameFormat(trimmed)) {
			throw new HTTPException(400, { message: 'Invalid username format' });
		}

		const userCount = await db.select({ count: count() }).from(users);
		const isFirstUser = (userCount[0]?.count ?? 0) === 0;

		const registrationModeSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'registration_mode'))
			.get();

		const registrationMode = (registrationModeSetting?.value ?? 'passphrase') as 'closed' | 'passphrase' | 'open';

		if (!isFirstUser && registrationMode === 'closed') {
			throw new HTTPException(403, { message: 'Registration is closed' });
		}

		if (registrationMode === 'passphrase') {
			const signupPassphrase = c.env.SIGNUP_PASSPHRASE;
			if (!signupPassphrase || !passphrase || passphrase !== signupPassphrase) {
				throw new HTTPException(403, { message: 'Invalid passphrase' });
			}
		}

		const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, trimmed)).get();
		if (existing) {
			throw new HTTPException(409, { message: 'Username already taken' });
		}

		if (!isFirstUser) {
			const usernameError = await validateUsername(db, trimmed);
			if (usernameError) {
				const status = usernameError === 'Username already exists' ? 409 : 400;
				throw new HTTPException(status, { message: usernameError });
			}
		}

		const tempUserId = genEaidx(Date.now());
		const options = await generateRegistrationOptions({
			rpName: 'CFW FileUp',
			rpID,
			userID: stringToUserId(tempUserId),
			userName: trimmed,
			userDisplayName: trimmed,
			attestationType: 'none',
			excludeCredentials: [],
			authenticatorSelection: {
				residentKey: 'preferred',
				userVerification: 'preferred',
			},
		});

		const challengeId = genEaidx(Date.now());
		await db.insert(passkeysChallenges).values({
			id: challengeId,
			challenge: options.challenge,
			userId: `signup:${tempUserId}:${trimmed}`,
			type: 'signup',
			expiresAt: Date.now() + CHALLENGE_TTL_MS,
		});

		cleanupExpiredChallenges(db);

		return c.json({ challengeId, options }, 200);
	}, apiDef['/api/passkey/signup/begin'].res),
);

// ─── Passkey signup finish ──────────────────────────────────────────────────

app.post(
	'/signup/finish',
	describeRoute(omitResAndReq(apiDef['/api/passkey/signup/finish'])),
	validator('json', apiDef['/api/passkey/signup/finish'].req),
	describeResponse(async (c: JsonCtx<'/api/passkey/signup/finish', Env>) => {
		const db = getDb(c.env);
		const { rpID, origin } = getRpInfo(c.req.url);
		const body = c.req.valid('json');
		const credential = body.credential;

		const now = Date.now();
		const challengeRecord = await db
			.select()
			.from(passkeysChallenges)
			.where(and(eq(passkeysChallenges.id, body.challengeId), eq(passkeysChallenges.type, 'signup')))
			.get();

		if (!challengeRecord || challengeRecord.expiresAt < now) {
			throw new HTTPException(400, { message: 'Invalid or expired challenge' });
		}

		const parts = challengeRecord.userId?.split(':') ?? [];
		if (parts.length < 3 || parts[0] !== 'signup' || !parts[1]) {
			throw new HTTPException(400, { message: 'Invalid challenge data' });
		}
		const userId = parts[1];
		const username = parts.slice(2).join(':');

		await db.delete(passkeysChallenges).where(eq(passkeysChallenges.id, body.challengeId));

		const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
		if (existing) {
			throw new HTTPException(409, { message: 'Username already taken' });
		}

		const userCount = await db.select({ count: count() }).from(users);
		const isFirstUser = (userCount[0]?.count ?? 0) === 0;
		if (!isFirstUser) {
			const usernameError = await validateUsername(db, username);
			if (usernameError) {
				const status = usernameError === 'Username already exists' ? 409 : 400;
				throw new HTTPException(status, { message: usernameError });
			}
		}

		let verification;
		try {
			verification = await verifyRegistrationResponse({
				response: credential,
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

		const { credential: cred } = verification.registrationInfo;

		await db.insert(users).values({ id: userId, username, passwordHash: null, isAdmin: isFirstUser, isSuspended: false });
		await db
			.insert(usedUsernames)
			.values({ username: username.toLowerCase() })
			.onConflictDoNothing();

		const passkeyId = genEaidx(Date.now());
		await db.insert(passkeys).values({
			id: passkeyId,
			userId,
			credentialId: cred.id,
			publicKey: uint8ArrayToBase64(cred.publicKey),
			counter: cred.counter,
			transports: credential.response.transports ? JSON.stringify(credential.response.transports) : null,
			name: body.passkeyName?.trim() ?? null,
			createdAt: parseEaidx(passkeyId).date.getTime(),
		});

		const tokenId = genEaidx(Date.now());
		const tokenValue = generateToken();
		await db.insert(tokens).values({ id: tokenId, userId, token: tokenValue });

		return c.json({ token: tokenValue }, 200);
	}, apiDef['/api/passkey/signup/finish'].res),
);

export const passkeyRoutes = app;
