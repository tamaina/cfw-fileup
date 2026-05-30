import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, count, and } from 'drizzle-orm';
import { apiError } from '../utils/api-error';
import { users, tokens, appSettings, passkeys, backupCodes } from '../scheme/index';
import { getDb } from '../utils/db';
import { hashPassword, tokenToDigest, verifyPassword, generateToken } from '../utils/crypto';
import { genEaidx } from '../../shared/eaid-x';
import { isTurnstileConfigured, verifyTurnstile } from '../utils/turnstile';
import { validateUsername } from '../utils/name-validation';
import { apiDef, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';
import { recordModerationEvent } from '../utils/moderation';
import { getInitialEffectiveQuotaForUser } from '../utils/rate-limit';
import { runContextBackgroundTask } from '../utils/background-task';
import { getRequestIp } from '../utils/request-ip';
import { assertRateLimit, rateLimitKey } from '../utils/rate-limit-binding';
import { sendLoginNotification } from './login-email';

const app = new Hono<{ Bindings: Env }>();

async function hashBackupCode(code: string): Promise<Uint8Array> {
	const data = new TextEncoder().encode(code);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return new Uint8Array(hashBuffer);
}

app.post(
	'/signup',
	describeRoute(omitResAndReq(apiDef['/api/signup'])),
	validator('json', apiDef['/api/signup'].req),
	describeResponse(async (c: JsonCtx<'/api/signup', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		// username は schema で trim・minLength・maxLength・regex 検証済み
		const { username, password } = body;
		await assertRateLimit(c.env, 'AUTH_RATE_LIMITER', rateLimitKey('signup', username, getRequestIp(c.req)));

		if (isTurnstileConfigured(c.env)) {
			const token = body.turnstileToken;
			if (!token || !await verifyTurnstile(token, c.env.TURNSTILE_SECRET)) {
				throw apiError(400, 'TURNSTILE_VERIFICATION_FAILED');
			}
		}

		const userCount = await db.select({ count: count() }).from(users);
		const isFirstUser = (userCount[0]?.count ?? 0) === 0;

		if (!isFirstUser) {
			const googleRequiredSetting = await db
				.select()
				.from(appSettings)
				.where(eq(appSettings.key, 'google_required'))
				.get();

			if (googleRequiredSetting?.value === 'true') {
				throw apiError(403, 'ONLY_GOOGLE_ACCOUNT_REGISTRATION_IS_ALLOWED');
			}
		}

		const registrationModeSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'registration_mode'))
			.get();

		const registrationMode = (registrationModeSetting?.value ?? 'passphrase') as 'closed' | 'passphrase' | 'open';

		if (!isFirstUser && registrationMode === 'closed') {
			throw apiError(403, 'REGISTRATION_IS_CLOSED');
		}

		if (registrationMode === 'passphrase') {
			const signupPassphrase = c.env.SIGNUP_PASSPHRASE;
			if (!signupPassphrase || !body.passphrase || body.passphrase !== signupPassphrase) {
				throw apiError(403, 'INVALID_PASSPHRASE');
			}
		}

		// 最初のユーザー（admin）は禁止名・重複チェックをスキップ
		if (!isFirstUser) {
			const usernameError = await validateUsername(db, username);
			if (usernameError) {
				const status = usernameError === 'Username already exists' ? 409 : 400;
				throw apiError(status, usernameError === 'Username already exists' ? 'USERNAME_ALREADY_EXISTS' : 'INVALID_USERNAME_FORMAT', usernameError);
			}
		}

		const now = Date.now();
		const userId = genEaidx(now);
		const passwordHash = await hashPassword(password);
		const initialQuota = await getInitialEffectiveQuotaForUser(c.env, now);

		try {
			await db.insert(users).values({
				id: userId,
				username,
				passwordHash,
				isAdmin: isFirstUser,
				isSuspended: false,
				effectiveMaxBuckets: initialQuota.maxBuckets,
				effectiveMaxBucketSizeBytes: initialQuota.maxBucketSizeBytes,
				effectiveMaxFilesPerBucket: initialQuota.maxFilesPerBucket,
				effectiveMaxDailyUploads: initialQuota.maxDailyUploads,
				effectiveCanUseDownloadCount: initialQuota.canUseDownloadCount,
				effectiveShowAds: initialQuota.showAds,
				effectiveCanDisableFileAds: initialQuota.canDisableFileAds,
				effectiveQuotaExpiresAt: initialQuota.effectiveQuotaExpiresAt,
				effectiveQuotaUpdatedAt: initialQuota.effectiveQuotaUpdatedAt,
				effectiveQuotaSource: initialQuota.effectiveQuotaSource,
			});
		} catch (e) {
			if (e instanceof Error && e.message.includes('users_single_admin_idx')) throw apiError(409, 'USERNAME_ALREADY_EXISTS');
			if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) throw apiError(409, 'USERNAME_ALREADY_EXISTS');
			throw e;
		}

		const tokenId = genEaidx(Date.now());
		const tokenValue = generateToken();
		const tokenBytes = await tokenToDigest(tokenValue);
		if (tokenBytes === null) throw apiError(500, 'INTERNAL_SERVER_ERROR');

		await db.insert(tokens).values({
			id: tokenId,
			userId,
			token: tokenBytes,
		});
		await recordModerationEvent(c, 'user_token_created', { tokenId, method: 'signup' }, userId, tokenId);

		return c.json({ userId, token: tokenValue }, 200);
	}, apiDef['/api/signup'].res),
);

app.post(
	'/signin',
	describeRoute(omitResAndReq(apiDef['/api/signin'])),
	validator('json', apiDef['/api/signin'].req),
	describeResponse(async (c: JsonCtx<'/api/signin', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const { username, password } = body;
		await assertRateLimit(c.env, 'AUTH_RATE_LIMITER', rateLimitKey('signin', username, getRequestIp(c.req)));

		if (isTurnstileConfigured(c.env)) {
			const token = body.turnstileToken;
			if (!token || !await verifyTurnstile(token, c.env.TURNSTILE_SECRET)) {
				throw apiError(400, 'TURNSTILE_VERIFICATION_FAILED');
			}
		}

		const user = await db.select().from(users).where(eq(users.username, username)).get();

		if (!user) {
			throw apiError(401, 'INVALID_CREDENTIALS');
		}

		if (user.isSuspended) {
			throw apiError(403, 'ACCOUNT_IS_SUSPENDED');
		}

		const googleRequiredSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'google_required'))
			.get();

		if (googleRequiredSetting?.value === 'true') {
			throw apiError(403, 'ONLY_GOOGLE_ACCOUNT_SIGN_IN_IS_ALLOWED');
		}

		if (!user.passwordHash) {
			throw apiError(401, 'INVALID_CREDENTIALS');
		}
		const passwordValid = await verifyPassword(password, user.passwordHash);
		if (!passwordValid) {
			throw apiError(401, 'INVALID_CREDENTIALS');
		}

		const userPasskeys = await db
			.select({ id: passkeys.id })
			.from(passkeys)
			.where(eq(passkeys.userId, user.id))
			.limit(1);

		if (userPasskeys.length > 0) {
			const normalizedBackupCode = body.backupCode?.toUpperCase().replace(/[\s-]/g, '') ?? '';
			if (!normalizedBackupCode) {
				throw apiError(401, 'BACKUP_CODE_REQUIRED');
			}

			const codeHash = await hashBackupCode(normalizedBackupCode);
			const codeRecord = await db
				.select()
				.from(backupCodes)
				.where(and(eq(backupCodes.userId, user.id), eq(backupCodes.codeHash, codeHash)))
				.get();

			if (!codeRecord || codeRecord.usedAt !== null) {
				throw apiError(401, 'INVALID_CREDENTIALS_OR_CODE');
			}

			await db.update(backupCodes).set({ usedAt: Date.now() }).where(eq(backupCodes.id, codeRecord.id));
		}

		const tokenId = genEaidx(Date.now());
		const tokenValue = generateToken();
		const tokenBytes = await tokenToDigest(tokenValue);
		if (tokenBytes === null) throw apiError(500, 'INTERNAL_SERVER_ERROR');

		await db.insert(tokens).values({
			id: tokenId,
			userId: user.id,
			token: tokenBytes,
		});
		await recordModerationEvent(c, 'user_token_created', { tokenId, method: 'signin' }, user.id, tokenId);
		runContextBackgroundTask(c, sendLoginNotification(c.env, {
			userId: user.id,
			method: 'password',
			request: c.req,
			tokenId,
		}), 'Failed to send login notification:');

		return c.json({ token: tokenValue }, 200);
	}, apiDef['/api/signin'].res),
);

export const authRoutes = app;
