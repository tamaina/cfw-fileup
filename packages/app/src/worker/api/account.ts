import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { and, count, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { createPublicClient, http, getAddress, type Hex } from 'viem';
import { createSiweMessage, generateSiweNonce, verifySiweMessage } from 'viem/siwe';
import { misskeyAccounts, paymentChains, plans, users, tokens, moderationEvents, userPlanAssignments, userWallets, walletLinkChallenges } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { validateUsername } from '../utils/name-validation';
import { apiDef, getResponseDefWithAuth } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';
import { apiError } from '../utils/api-error';
import { genEaidx, parseEaidx } from '../../shared/eaid-x';
import { idPage, pageParams } from '../utils/pagination';
import { getPaymentChainRpcUrl, normalizeEthAddress } from '../utils/payment-rpc';
import { getEffectiveQuotaForUser } from '../utils/rate-limit';
import { createEmailVerification, getEmailSendPreflightFailure, sendEmailLines, verifyAccountEmail, type EmailSendPreflightFailure } from '../utils/email';
import { isTurnstileConfigured, verifyTurnstile } from '../utils/turnstile';
import { getContextWaitUntil, runBackgroundTask, type WaitUntil } from '../utils/background-task';
import { getAppName } from '../utils/app-name';
import { getRequestIp } from '../utils/request-ip';
import { assertRateLimit, rateLimitKey } from '../utils/rate-limit-binding';
import { createIndieAuthUrl } from './indieauth';
import { createGoogleAuthUrl } from './google-auth';
import type { JsonCtx } from '../../shared/api';

const app = new Hono<{ Bindings: Env }>();
const RECENT_AUTH_MS = 5 * 60 * 1000;
const WALLET_LINK_CHALLENGE_TTL_MS = 10 * 60 * 1000;

app.use(authMiddleware);

async function assertCanSendVerificationEmail(env: Env, email: string): Promise<void> {
	const failure = await getEmailSendPreflightFailure(env, email);
	if (failure === null) return;
	const errors: Record<EmailSendPreflightFailure, { status: 400 | 503; code: 'EMAIL_NOT_CONFIGURED' | 'PUBLIC_APP_URL_NOT_CONFIGURED' | 'EMAIL_DOMAIN_HAS_NO_MX'; message: string }> = {
		email_not_configured: { status: 503, code: 'EMAIL_NOT_CONFIGURED', message: 'Email sending is not configured' },
		public_app_url_not_configured: { status: 503, code: 'PUBLIC_APP_URL_NOT_CONFIGURED', message: 'PUBLIC_APP_URL is not configured' },
		recipient_domain_has_no_mx: { status: 400, code: 'EMAIL_DOMAIN_HAS_NO_MX', message: 'Recipient domain has no MX record' },
	};
	const error = errors[failure];
	throw apiError(error.status, error.code, error.message);
}

async function sendEmailVerification(env: Env, userId: string, email: string, requestUrl: string, waitUntil?: WaitUntil): Promise<void> {
	const now = Date.now();
	const { verifyUrl } = await createEmailVerification(env, userId, email, requestUrl, now);
	const appName = await getAppName(env);
	runBackgroundTask(waitUntil, sendEmailLines(env, email, `${appName} メールアドレス確認`, [
		`${appName} のメールアドレス確認です。`,
		'',
		'次のリンクを開いてメールアドレスを確認してください。',
		verifyUrl,
		'',
		'このメールに心当たりがない場合は破棄してください。',
	]), 'Failed to send email verification:');
}

async function assertSensitiveActionAuth(env: Env, userId: string, currentPassword: string | undefined, turnstileToken: string | undefined, reauthenticatedAt: number | null): Promise<void> {
	if (reauthenticatedAt !== null && Date.now() - reauthenticatedAt <= RECENT_AUTH_MS) return;

	const db = getDb(env);
	const userRecord = await db.select().from(users).where(eq(users.id, userId)).get();
	if (!userRecord) throw apiError(404, 'USER_NOT_FOUND');
	if (!currentPassword) {
		throw apiError(401, userRecord.passwordHash ? 'CURRENT_PASSWORD_IS_REQUIRED' : 'RECENT_AUTHENTICATION_REQUIRED');
	}
	if (!userRecord.passwordHash) throw apiError(401, 'INVALID_PASSWORD');
	await assertRateLimit(env, 'AUTH_RATE_LIMITER', rateLimitKey('sensitive-action-password', userId));
	if (isTurnstileConfigured(env)) {
		if (!turnstileToken) throw apiError(400, 'TURNSTILE_TOKEN_IS_REQUIRED');
		if (!await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET)) {
			throw apiError(400, 'TURNSTILE_VERIFICATION_FAILED');
		}
	}
	const passwordValid = await verifyPassword(currentPassword, userRecord.passwordHash);
	if (!passwordValid) throw apiError(401, 'INVALID_PASSWORD');
}

app.post(
	'/me',
	describeRoute(omitResAndReq(apiDef['/api/account/me'])),
	validator('json', apiDef['/api/account/me'].req),
	describeResponse(async (c: JsonCtx<'/api/account/me', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const userRecord = await db.select().from(users).where(eq(users.id, user.id)).get();
		if (!userRecord) throw apiError(404, 'USER_NOT_FOUND');
		const linkedMisskeyAccounts = await db
			.select({ id: misskeyAccounts.id })
			.from(misskeyAccounts)
			.where(eq(misskeyAccounts.userId, user.id))
			.limit(1);
		return c.json({
			id: user.id,
			username: user.username,
			isAdmin: user.isAdmin,
			isModerator: user.isModerator,
			termsAgreedAt: user.termsAgreedAt,
			hasGoogle: userRecord.googleId !== null,
			hasMisskey: linkedMisskeyAccounts.length > 0,
			hasPassword: userRecord.passwordHash !== null,
			recentlyAuthenticated: user.reauthenticatedAt !== null && Date.now() - user.reauthenticatedAt <= RECENT_AUTH_MS,
			email: userRecord.email,
			emailVerifiedAt: userRecord.emailVerifiedAt,
		}, 200);
	}, getResponseDefWithAuth('/api/account/me')),
);

app.post(
	'/link/google/begin',
	describeRoute(omitResAndReq(apiDef['/api/account/link/google/begin'])),
	validator('json', apiDef['/api/account/link/google/begin'].req),
	describeResponse(async (c: JsonCtx<'/api/account/link/google/begin', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		await assertSensitiveActionAuth(c.env, user.id, body.currentPassword, body.turnstileToken, user.reauthenticatedAt);
		return c.json({ url: await createGoogleAuthUrl(c.env, new URL(c.req.url), user.id) }, 200);
	}, getResponseDefWithAuth('/api/account/link/google/begin')),
);

app.post(
	'/link/indieauth/begin',
	describeRoute(omitResAndReq(apiDef['/api/account/link/indieauth/begin'])),
	validator('json', apiDef['/api/account/link/indieauth/begin'].req),
	describeResponse(async (c: JsonCtx<'/api/account/link/indieauth/begin', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		await assertSensitiveActionAuth(c.env, user.id, body.currentPassword, body.turnstileToken, user.reauthenticatedAt);
		return c.json({ url: await createIndieAuthUrl(c.env, new URL(c.req.url), body.profileUrl, user.id) }, 200);
	}, getResponseDefWithAuth('/api/account/link/indieauth/begin')),
);

app.post(
	'/linked-misskey/list',
	describeRoute(omitResAndReq(apiDef['/api/account/linked-misskey/list'])),
	validator('json', apiDef['/api/account/linked-misskey/list'].req),
	describeResponse(async (c: JsonCtx<'/api/account/linked-misskey/list', Env>) => {
		const user = c.get('user');
		const accounts = await getDb(c.env)
			.select({
				id: misskeyAccounts.id,
				misskeyId: misskeyAccounts.misskeyId,
				issuer: misskeyAccounts.issuer,
				username: misskeyAccounts.username,
				name: misskeyAccounts.name,
				createdAt: misskeyAccounts.createdAt,
			})
			.from(misskeyAccounts)
			.where(eq(misskeyAccounts.userId, user.id));
		return c.json(accounts, 200);
	}, getResponseDefWithAuth('/api/account/linked-misskey/list')),
);

app.post(
	'/wallets/list',
	describeRoute(omitResAndReq(apiDef['/api/account/wallets/list'])),
	validator('json', apiDef['/api/account/wallets/list'].req),
	describeResponse(async (c: JsonCtx<'/api/account/wallets/list', Env>) => {
		const user = c.get('user');
		const wallets = await getDb(c.env)
			.select({
				id: userWallets.id,
				chainId: userWallets.chainId,
				address: userWallets.address,
				label: userWallets.label,
				createdAt: userWallets.createdAt,
				updatedAt: userWallets.updatedAt,
			})
			.from(userWallets)
			.where(eq(userWallets.userId, user.id))
			.orderBy(desc(userWallets.id));
		return c.json(wallets, 200);
	}, getResponseDefWithAuth('/api/account/wallets/list')),
);

app.post(
	'/wallets/link/chains',
	describeRoute(omitResAndReq(apiDef['/api/account/wallets/link/chains'])),
	validator('json', apiDef['/api/account/wallets/link/chains'].req),
	describeResponse(async (c: JsonCtx<'/api/account/wallets/link/chains', Env>) => {
		const chains = await getDb(c.env)
			.select({
				chainId: paymentChains.chainId,
				name: paymentChains.name,
				nativeCurrencyName: paymentChains.nativeCurrencyName,
				nativeCurrencySymbol: paymentChains.nativeCurrencySymbol,
				nativeCurrencyDecimals: paymentChains.nativeCurrencyDecimals,
				blockExplorerUrl: paymentChains.blockExplorerUrl,
			})
			.from(paymentChains)
			.where(eq(paymentChains.isEnabled, true))
			.orderBy(desc(paymentChains.chainId));
		return c.json(chains.filter(chain => getPaymentChainRpcUrl(c.env, chain.chainId) !== null), 200);
	}, getResponseDefWithAuth('/api/account/wallets/link/chains')),
);

app.post(
	'/wallets/unlink',
	describeRoute(omitResAndReq(apiDef['/api/account/wallets/unlink'])),
	validator('json', apiDef['/api/account/wallets/unlink'].req),
	describeResponse(async (c: JsonCtx<'/api/account/wallets/unlink', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const wallet = await db
			.select({ id: userWallets.id })
			.from(userWallets)
			.where(and(eq(userWallets.id, body.walletId), eq(userWallets.userId, user.id)))
			.get();
		if (!wallet) throw apiError(404, 'WALLET_NOT_FOUND');
		await db.delete(userWallets).where(eq(userWallets.id, body.walletId));
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/account/wallets/unlink')),
);

app.post(
	'/wallets/link/begin',
	describeRoute(omitResAndReq(apiDef['/api/account/wallets/link/begin'])),
	validator('json', apiDef['/api/account/wallets/link/begin'].req),
	describeResponse(async (c: JsonCtx<'/api/account/wallets/link/begin', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		await assertSensitiveActionAuth(c.env, user.id, body.currentPassword, body.turnstileToken, user.reauthenticatedAt);
		const rpcUrl = getPaymentChainRpcUrl(c.env, body.chainId);
		if (!rpcUrl) throw apiError(400, 'PAYMENT_CHAIN_RPC_NOT_CONFIGURED');

		const address = normalizeEthAddress(body.address);
		const existing = await db
			.select({ id: userWallets.id })
			.from(userWallets)
			.where(and(eq(userWallets.chainId, body.chainId), eq(userWallets.address, address)))
			.get();
		if (existing) throw apiError(400, 'WALLET_ALREADY_LINKED');

		const now = Date.now();
		const requestUrl = new URL(c.req.url);
		const domain = requestUrl.host;
		const uri = requestUrl.origin;
		const nonce = generateSiweNonce();
		const message = createSiweMessage({
			address: getAddress(address),
			chainId: body.chainId,
			domain,
			nonce,
			statement: 'Link this wallet to your cfw-fileup account.',
			uri,
			version: '1',
			issuedAt: new Date(now),
			expirationTime: new Date(now + WALLET_LINK_CHALLENGE_TTL_MS),
		});

		await db.insert(walletLinkChallenges).values({
			nonce,
			userId: user.id,
			chainId: body.chainId,
			address,
			domain,
			uri,
			message,
			createdAt: now,
			expiresAt: now + WALLET_LINK_CHALLENGE_TTL_MS,
			usedAt: null,
		});

		return c.json({ nonce, message }, 200);
	}, getResponseDefWithAuth('/api/account/wallets/link/begin')),
);

app.post(
	'/wallets/link/verify',
	describeRoute(omitResAndReq(apiDef['/api/account/wallets/link/verify'])),
	validator('json', apiDef['/api/account/wallets/link/verify'].req),
	describeResponse(async (c: JsonCtx<'/api/account/wallets/link/verify', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const now = Date.now();
		const challenge = await db
			.select()
			.from(walletLinkChallenges)
			.where(and(eq(walletLinkChallenges.nonce, body.nonce), eq(walletLinkChallenges.userId, user.id)))
			.get();
		if (!challenge || challenge.usedAt !== null || challenge.expiresAt <= now || challenge.message !== body.message) {
			throw apiError(400, 'WALLET_CHALLENGE_NOT_FOUND');
		}

		const rpcUrl = getPaymentChainRpcUrl(c.env, challenge.chainId);
		if (!rpcUrl) throw apiError(400, 'PAYMENT_CHAIN_RPC_NOT_CONFIGURED');
		const client = createPublicClient({ transport: http(rpcUrl) });
		let verified: boolean;
		try {
			verified = await verifySiweMessage(client, {
				address: getAddress(challenge.address),
				domain: challenge.domain,
				message: challenge.message,
				nonce: challenge.nonce,
				signature: body.signature as Hex,
				time: new Date(now),
			});
		} catch {
			throw apiError(400, 'WALLET_SIGNATURE_INVALID');
		}
		if (!verified) throw apiError(400, 'WALLET_SIGNATURE_INVALID');

		const existing = await db
			.select({ id: userWallets.id })
			.from(userWallets)
			.where(and(eq(userWallets.chainId, challenge.chainId), eq(userWallets.address, challenge.address)))
			.get();
		if (existing) throw apiError(400, 'WALLET_ALREADY_LINKED');

		const wallet = {
			id: genEaidx(now),
			userId: user.id,
			chainId: challenge.chainId,
			address: challenge.address,
			label: null,
			createdAt: now,
			updatedAt: now,
		};
		await db.insert(userWallets).values(wallet);
		await db.update(walletLinkChallenges).set({ usedAt: now }).where(eq(walletLinkChallenges.nonce, challenge.nonce));
		return c.json({
			id: wallet.id,
			chainId: wallet.chainId,
			address: wallet.address,
			label: wallet.label,
			createdAt: wallet.createdAt,
			updatedAt: wallet.updatedAt,
		}, 200);
	}, getResponseDefWithAuth('/api/account/wallets/link/verify')),
);

app.post(
	'/agree-terms',
	describeRoute(omitResAndReq(apiDef['/api/account/agree-terms'])),
	validator('json', apiDef['/api/account/agree-terms'].req),
	describeResponse(async (c: JsonCtx<'/api/account/agree-terms', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		await db.update(users).set({ termsAgreedAt: body.agreedAt }).where(eq(users.id, user.id));
		return c.json({ ok: true, termsAgreedAt: body.agreedAt }, 200);
	}, getResponseDefWithAuth('/api/account/agree-terms')),
);

app.post(
	'/effective-quota',
	describeRoute(omitResAndReq(apiDef['/api/account/effective-quota'])),
	validator('json', apiDef['/api/account/effective-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/account/effective-quota', Env>) => {
		const user = c.get('user');
		const quota = await getEffectiveQuotaForUser(c.env, user.id);
		return c.json(quota, 200);
	}, getResponseDefWithAuth('/api/account/effective-quota')),
);

app.post(
	'/current-plan',
	describeRoute(omitResAndReq(apiDef['/api/account/current-plan'])),
	validator('json', apiDef['/api/account/current-plan'].req),
	describeResponse(async (c: JsonCtx<'/api/account/current-plan', Env>) => {
		const user = c.get('user');
		const now = Date.now();
		const assignment = await getDb(c.env)
			.select({
				userId: userPlanAssignments.userId,
				planId: userPlanAssignments.planId,
				planName: plans.name,
				expiresAt: userPlanAssignments.expiresAt,
				createdAt: userPlanAssignments.createdAt,
				updatedAt: userPlanAssignments.updatedAt,
			})
			.from(userPlanAssignments)
			.innerJoin(plans, eq(userPlanAssignments.planId, plans.id))
			.where(and(
				eq(userPlanAssignments.userId, user.id),
				lt(userPlanAssignments.startsAt, now + 1),
				gt(userPlanAssignments.expiresAt, now),
			))
			.orderBy(desc(plans.sortOrder), desc(userPlanAssignments.expiresAt))
			.get();
		return c.json(assignment ?? null, 200);
	}, getResponseDefWithAuth('/api/account/current-plan')),
);

app.post(
	'/update',
	describeRoute(omitResAndReq(apiDef['/api/account/update'])),
	validator('json', apiDef['/api/account/update'].req),
	describeResponse(async (c: JsonCtx<'/api/account/update', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		const userRecord = await db.select().from(users).where(eq(users.id, user.id)).get();

		if (!userRecord) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		const isInitialPasswordSetup = userRecord.passwordHash === null && body.newPassword !== undefined;
		const hasRecentWebAuthn = user.reauthenticatedAt !== null && Date.now() - user.reauthenticatedAt <= RECENT_AUTH_MS;
		if (!isInitialPasswordSetup || !hasRecentWebAuthn) {
			if (!body.currentPassword) {
				throw apiError(400, userRecord.passwordHash === null ? 'RECENT_WEBAUTHN_REQUIRED' : 'CURRENT_PASSWORD_IS_REQUIRED');
			}
			if (!userRecord.passwordHash) {
				throw apiError(401, 'INVALID_PASSWORD');
			}
			const passwordValid = await verifyPassword(body.currentPassword, userRecord.passwordHash);
			if (!passwordValid) {
				throw apiError(401, 'INVALID_PASSWORD');
			}
		}

		if (body.username) {
			const newUsername = body.username.trim();

			if (newUsername.length < 1 || newUsername.length > 32) {
				throw apiError(400, 'INVALID_USERNAME_FORMAT', 'username must be 1-32 characters');
			}

			if (newUsername !== userRecord.username) {
				// 文字種・禁止ワード・重複（大文字小文字を区別しない）チェック
				const usernameError = await validateUsername(db, newUsername, userRecord.id);
				if (usernameError) {
					const status = usernameError === 'Username already exists' ? 409 : 400;
					throw apiError(status, usernameError === 'Username already exists' ? 'USERNAME_ALREADY_EXISTS' : 'INVALID_USERNAME_FORMAT', usernameError);
				}

				try {
					await db.update(users).set({ username: newUsername }).where(eq(users.id, user.id));
				} catch (e) {
					if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) throw apiError(409, 'USERNAME_ALREADY_EXISTS');
					throw e;
				}
			}
		}

		if (body.newPassword) {
			if (body.newPassword.length < 8) {
				throw apiError(400, 'INVALID_PASSWORD', 'password must be at least 8 characters');
			}

			const passwordHash = await hashPassword(body.newPassword);
			await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
		}

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/account/update')),
);

app.post(
	'/email/update',
	describeRoute(omitResAndReq(apiDef['/api/account/email/update'])),
	validator('json', apiDef['/api/account/email/update'].req),
	describeResponse(async (c: JsonCtx<'/api/account/email/update', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const email = c.req.valid('json').email?.trim().toLowerCase() ?? null;

		if (email !== null) {
			await assertCanSendVerificationEmail(c.env, email);
		}

		await db.update(users).set({
			email,
			emailVerifiedAt: null,
		}).where(eq(users.id, user.id));

		if (email !== null) {
			await sendEmailVerification(c.env, user.id, email, c.req.url, getContextWaitUntil(c));
		}

		return c.json({ ok: true, email, emailVerifiedAt: null }, 200);
	}, getResponseDefWithAuth('/api/account/email/update')),
);

app.post(
	'/email/resend-verification',
	describeRoute(omitResAndReq(apiDef['/api/account/email/resend-verification'])),
	validator('json', apiDef['/api/account/email/resend-verification'].req),
	describeResponse(async (c: JsonCtx<'/api/account/email/resend-verification', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const userRecord = await db.select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, user.id)).get();
		if (!userRecord?.email) throw apiError(400, 'EMAIL_IS_REQUIRED');
		if (userRecord.emailVerifiedAt === null) {
			await assertCanSendVerificationEmail(c.env, userRecord.email);
			await sendEmailVerification(c.env, user.id, userRecord.email, c.req.url, getContextWaitUntil(c));
		}
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/account/email/resend-verification')),
);

app.post(
	'/email/verify',
	describeRoute(omitResAndReq(apiDef['/api/account/email/verify'])),
	validator('json', apiDef['/api/account/email/verify'].req),
	describeResponse(async (c: JsonCtx<'/api/account/email/verify', Env>) => {
		const body = c.req.valid('json');
		await assertRateLimit(c.env, 'PUBLIC_FORM_RATE_LIMITER', rateLimitKey('email-verify', body.token, getRequestIp(c.req)));
		const turnstileSecret = c.env.TURNSTILE_SECRET as string;
		if (isTurnstileConfigured(c.env)) {
			if (!body.turnstileToken) throw apiError(400, 'TURNSTILE_TOKEN_IS_REQUIRED');
			if (!await verifyTurnstile(body.turnstileToken, turnstileSecret)) {
				throw apiError(400, 'TURNSTILE_VERIFICATION_FAILED');
			}
		}
		try {
			const result = await verifyAccountEmail(c.env, body.token);
			return c.json({ ok: true, ...result }, 200);
		} catch {
			throw apiError(400, 'EMAIL_VERIFICATION_TOKEN_INVALID');
		}
	}, getResponseDefWithAuth('/api/account/email/verify')),
);

app.post(
	'/tokens',
	describeRoute(omitResAndReq(apiDef['/api/account/tokens'])),
	validator('json', apiDef['/api/account/tokens'].req),
	describeResponse(async (c: JsonCtx<'/api/account/tokens', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const { limit, cursor } = pageParams(c.req.valid('json'));
		const rows = await db
			.select({
				id: tokens.id,
				isRevoked: tokens.isRevoked,
			})
			.from(tokens)
			.where(cursor ? and(eq(tokens.userId, user.id), lt(tokens.id, cursor)) : eq(tokens.userId, user.id))
			.orderBy(desc(tokens.id))
			.limit(limit + 1);
		const pageRows = rows.slice(0, limit);
		const tokenIds = pageRows.map(token => token.id);
		const latestEventIds = tokenIds.length === 0
			? []
			: await db
				.select({
					id: sql<string>`max(${moderationEvents.id})`,
				})
				.from(moderationEvents)
				.where(inArray(moderationEvents.userTokenId, tokenIds))
				.groupBy(moderationEvents.userTokenId);
		const latestEvents = latestEventIds.length === 0
			? []
			: await db
				.select({
					userTokenId: moderationEvents.userTokenId,
					ipAddress: moderationEvents.ipAddress,
				})
				.from(moderationEvents)
				.where(inArray(moderationEvents.id, latestEventIds.map(event => event.id)));
		const lastIpByTokenId = new Map<string, string | null>();
		for (const event of latestEvents) {
			if (event.userTokenId === null || lastIpByTokenId.has(event.userTokenId)) continue;
			lastIpByTokenId.set(event.userTokenId, event.ipAddress);
		}

		return c.json({
			...idPage(rows, limit, token => ({
				id: token.id,
				createdAt: parseEaidx(token.id).date.getTime(),
				lastIpAddress: lastIpByTokenId.get(token.id) ?? null,
				isCurrent: token.id === user.tokenId,
				isRevoked: token.isRevoked,
			})),
		}, 200);
	}, getResponseDefWithAuth('/api/account/tokens')),
);

app.post(
	'/tokens/revoke-all',
	describeRoute(omitResAndReq(apiDef['/api/account/tokens/revoke-all'])),
	validator('json', apiDef['/api/account/tokens/revoke-all'].req),
	describeResponse(async (c: JsonCtx<'/api/account/tokens/revoke-all', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const [{ revokedCount }] = await db
			.select({ revokedCount: count() })
			.from(tokens)
			.where(and(eq(tokens.userId, user.id), eq(tokens.isRevoked, false)));

		await db
			.update(tokens)
			.set({ isRevoked: true })
			.where(and(eq(tokens.userId, user.id), eq(tokens.isRevoked, false)));

		return c.json({ ok: true, revokedCount }, 200);
	}, getResponseDefWithAuth('/api/account/tokens/revoke-all')),
);

export const accountRoutes = app;
