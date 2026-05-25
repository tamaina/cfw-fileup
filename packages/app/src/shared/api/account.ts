import * as v from 'valibot';
import { errorResponse, PageRequestFields, pagedResponse } from '../api.schemas.js';
import { nameFormatValidation } from '../name-validation.js';
import { MAX_PASSPHRASE_LENGTH, MAX_USERNAME_LENGTH } from '../const.js';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';

const AccountTokenResponse = v.pipe(
	v.object({
		id: v.string(),
		createdAt: v.number(),
		lastIpAddress: v.nullable(v.string()),
		isCurrent: v.boolean(),
		isRevoked: v.boolean(),
	}),
	v.metadata({ ref: 'AccountToken' }),
);
const EffectiveQuotaSource = v.picklist(['plan', 'custom', 'global', 'default']);
const EffectiveQuotaResponse = v.pipe(
	v.object({
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
		canUseDownloadCount: v.boolean(),
		effectiveQuotaExpiresAt: v.nullable(v.number()),
		effectiveQuotaUpdatedAt: v.nullable(v.number()),
		effectiveQuotaSource: v.nullable(EffectiveQuotaSource),
	}),
	v.metadata({ ref: 'AccountEffectiveQuota' }),
);
const EthereumAddress = v.pipe(v.string(), v.regex(/^0x[a-fA-F0-9]{40}$/));
const HexSignature = v.pipe(v.string(), v.regex(/^0x[a-fA-F0-9]+$/));
const WalletResponse = v.pipe(
	v.object({
		id: v.string(),
		chainId: v.number(),
		address: EthereumAddress,
		label: v.nullable(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'UserWallet' }),
);

export const accountApiDef = {
	'/api/account/me': {
		summary: 'Get account info from authentication information',
		tags: ['account'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({
				id: v.string(),
				username: v.string(),
				isAdmin: v.boolean(),
				termsAgreedAt: v.nullable(v.number()),
				hasGoogle: v.boolean(),
				hasMisskey: v.boolean(),
				hasPassword: v.boolean(),
				recentlyAuthenticated: v.boolean(),
			}) } } },
		},
	},
	'/api/account/link/google/begin': {
		summary: 'Begin linking Google account',
		tags: ['account'],
		req: v.object({
			currentPassword: v.optional(v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH))),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ url: v.string() }) } } },
			401: errorResponse('Recent authentication or current password required', ['CURRENT_PASSWORD_IS_REQUIRED', 'INVALID_PASSWORD', 'RECENT_AUTHENTICATION_REQUIRED']),
			404: errorResponse('User not found', ['USER_NOT_FOUND']),
			503: errorResponse('Google OAuth is not configured', ['GOOGLE_OAUTH_IS_NOT_CONFIGURED']),
		},
	},
	'/api/account/link/indieauth/begin': {
		summary: 'Begin linking IndieAuth account',
		tags: ['account'],
		req: v.object({
			profileUrl: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
			currentPassword: v.optional(v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH))),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ url: v.string() }) } } },
			400: errorResponse('Bad request', ['INVALID_PROFILE_URL', 'INDIEAUTH_DISCOVERY_FAILED']),
			401: errorResponse('Recent authentication or current password required', ['CURRENT_PASSWORD_IS_REQUIRED', 'INVALID_PASSWORD', 'RECENT_AUTHENTICATION_REQUIRED']),
			403: errorResponse('Blocked server', ['THIS_MISSKEY_SERVER_IS_NOT_ALLOWED']),
			404: errorResponse('User not found', ['USER_NOT_FOUND']),
		},
	},
	'/api/account/linked-misskey/list': {
		summary: 'List linked Misskey accounts',
		tags: ['account'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.array(v.object({
				id: v.string(),
				misskeyId: v.string(),
				issuer: v.string(),
				username: v.nullable(v.string()),
				name: v.nullable(v.string()),
				createdAt: v.number(),
			})) } } },
		},
	},
	'/api/account/wallets/list': {
		summary: 'List linked wallets',
		tags: ['account'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.array(WalletResponse) } } },
		},
	},
	'/api/account/wallets/link/begin': {
		summary: 'Begin linking a wallet with SIWE',
		tags: ['account'],
		req: v.object({
			address: EthereumAddress,
			chainId: v.pipe(v.number(), v.integer(), v.minValue(1)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({
				nonce: v.string(),
				message: v.string(),
			}) } } },
			400: errorResponse('Invalid wallet link request', ['PAYMENT_CHAIN_RPC_NOT_CONFIGURED', 'PAYMENT_TRANSACTION_INVALID', 'WALLET_ALREADY_LINKED']),
		},
	},
	'/api/account/wallets/link/verify': {
		summary: 'Verify SIWE signature and link wallet',
		tags: ['account'],
		req: v.object({
			nonce: v.string(),
			message: v.string(),
			signature: HexSignature,
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: WalletResponse } } },
			400: errorResponse('Invalid wallet signature', ['PAYMENT_CHAIN_RPC_NOT_CONFIGURED', 'WALLET_ALREADY_LINKED', 'WALLET_CHALLENGE_NOT_FOUND', 'WALLET_SIGNATURE_INVALID']),
		},
	},
	'/api/account/agree-terms': {
		summary: 'Record terms agreement',
		tags: ['account'],
		req: v.object({ agreedAt: v.number() }),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true), termsAgreedAt: v.number() }) } } },
		},
	},
	'/api/account/effective-quota': {
		summary: 'Get effective quota for the current account',
		tags: ['account'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: EffectiveQuotaResponse } } },
		},
	},
	'/api/account/update': {
		summary: 'Update account info',
		tags: ['account'],
		req: v.object({
			username: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_USERNAME_LENGTH), nameFormatValidation)),
			newPassword: v.optional(v.pipe(v.string(), v.minLength(8), v.maxLength(MAX_PASSPHRASE_LENGTH))),
			currentPassword: v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: errorResponse('Bad request (missing currentPassword or password too short)', ['CURRENT_PASSWORD_IS_REQUIRED', 'INVALID_PASSWORD', 'INVALID_USERNAME_FORMAT']),
			404: errorResponse('User not found', ['USER_NOT_FOUND']),
			409: errorResponse('Username already exists', ['USERNAME_ALREADY_EXISTS']),
		},
	},
	'/api/account/tokens': {
		summary: 'List account access tokens',
		tags: ['account'],
		req: v.object(PageRequestFields),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(AccountTokenResponse) } } },
		},
	},
	'/api/account/tokens/revoke-all': {
		summary: 'Revoke all account access tokens',
		tags: ['account'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true), revokedCount: v.number() }) } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
