import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { createPublicClient, http, getAddress, type Hex } from 'viem';
import { createSiweMessage, generateSiweNonce, verifySiweMessage } from 'viem/siwe';
import { misskeyAccounts, users, usedUsernames, tokens, moderationEvents, userWallets, walletLinkChallenges } from '../scheme/index';
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
import { createGoogleAuthUrl } from './google-auth';
import { createIndieAuthUrl } from './indieauth';
import type { JsonCtx } from '../../shared/api';

const app = new Hono<{ Bindings: Env }>();
const RECENT_AUTH_MS = 10 * 60 * 1000;
const WALLET_LINK_CHALLENGE_TTL_MS = 10 * 60 * 1000;

app.use(authMiddleware);

async function assertSensitiveActionAuth(env: Env, userId: string, currentPassword: string | undefined, reauthenticatedAt: number | null): Promise<void> {
	if (reauthenticatedAt !== null && Date.now() - reauthenticatedAt <= RECENT_AUTH_MS) return;

	const db = getDb(env);
	const userRecord = await db.select().from(users).where(eq(users.id, userId)).get();
	if (!userRecord) throw apiError(404, 'USER_NOT_FOUND');
	if (!currentPassword) {
		throw apiError(401, userRecord.passwordHash ? 'CURRENT_PASSWORD_IS_REQUIRED' : 'RECENT_AUTHENTICATION_REQUIRED');
	}
	if (!userRecord.passwordHash) throw apiError(401, 'INVALID_PASSWORD');
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
			termsAgreedAt: user.termsAgreedAt,
			hasGoogle: userRecord.googleId !== null,
			hasMisskey: linkedMisskeyAccounts.length > 0,
			hasPassword: userRecord.passwordHash !== null,
			recentlyAuthenticated: user.reauthenticatedAt !== null && Date.now() - user.reauthenticatedAt <= RECENT_AUTH_MS,
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
		await assertSensitiveActionAuth(c.env, user.id, body.currentPassword, user.reauthenticatedAt);
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
		await assertSensitiveActionAuth(c.env, user.id, body.currentPassword, user.reauthenticatedAt);
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
	'/wallets/link/begin',
	describeRoute(omitResAndReq(apiDef['/api/account/wallets/link/begin'])),
	validator('json', apiDef['/api/account/wallets/link/begin'].req),
	describeResponse(async (c: JsonCtx<'/api/account/wallets/link/begin', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
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
		const verified = await verifySiweMessage(client, {
			address: getAddress(challenge.address),
			domain: challenge.domain,
			message: challenge.message,
			nonce: challenge.nonce,
			signature: body.signature as Hex,
			time: new Date(now),
		});
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
	'/update',
	describeRoute(omitResAndReq(apiDef['/api/account/update'])),
	validator('json', apiDef['/api/account/update'].req),
	describeResponse(async (c: JsonCtx<'/api/account/update', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.currentPassword) {
			throw apiError(400, 'CURRENT_PASSWORD_IS_REQUIRED');
		}

		const userRecord = await db.select().from(users).where(eq(users.id, user.id)).get();

		if (!userRecord) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		if (!userRecord.passwordHash) {
			throw apiError(401, 'INVALID_PASSWORD');
		}
		const passwordValid = await verifyPassword(body.currentPassword, userRecord.passwordHash);
		if (!passwordValid) {
			throw apiError(401, 'INVALID_PASSWORD');
		}

		if (body.username) {
			const newUsername = body.username.trim();

			if (newUsername.length < 1 || newUsername.length > 32) {
				throw apiError(400, 'INVALID_USERNAME_FORMAT', 'username must be 1-32 characters');
			}

			if (newUsername.toLowerCase() !== userRecord.username.toLowerCase()) {
				// 文字種・禁止ワード・重複（大文字小文字を区別しない）チェック
				const usernameError = await validateUsername(db, newUsername);
				if (usernameError) {
					const status = usernameError === 'Username already exists' ? 409 : 400;
					throw apiError(status, usernameError === 'Username already exists' ? 'USERNAME_ALREADY_EXISTS' : 'INVALID_USERNAME_FORMAT', usernameError);
				}

				await db.update(users).set({ username: newUsername }).where(eq(users.id, user.id));

				// lowercaseで used_usernames に登録（削除後も同名再利用不可）
				await db
					.insert(usedUsernames)
					.values({ username: newUsername.toLowerCase() })
					.onConflictDoNothing();
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
