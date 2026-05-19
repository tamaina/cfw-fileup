import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';

// ── Shared credential schemas ────────────────────────────────────────────────

const AuthenticatorTransportFuture = v.picklist([
	'ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb',
]);

/** AuthenticatorAttestationResponseJSON */
const AuthenticatorAttestationResponseJSON = v.pipe(
	v.object({
		clientDataJSON: v.string(),
		attestationObject: v.string(),
		authenticatorData: v.optional(v.string()),
		transports: v.optional(v.array(AuthenticatorTransportFuture)),
		publicKeyAlgorithm: v.optional(v.number()),
		publicKey: v.optional(v.string()),
	}),
	v.metadata({ ref: 'AuthenticatorAttestationResponseJSON' }),
);

/** AuthenticatorAssertionResponseJSON */
const AuthenticatorAssertionResponseJSON = v.pipe(
	v.object({
		clientDataJSON: v.string(),
		authenticatorData: v.string(),
		signature: v.string(),
		userHandle: v.optional(v.string()),
	}),
	v.metadata({ ref: 'AuthenticatorAssertionResponseJSON' }),
);

const AuthenticationExtensionsClientOutputs = v.pipe(
	v.record(v.string(), v.unknown()),
	v.metadata({ ref: 'AuthenticationExtensionsClientOutputs' }),
);

/** RegistrationResponseJSON — body from startRegistration() */
export const RegistrationResponseJSON = v.pipe(
	v.object({
		id: v.string(),
		rawId: v.string(),
		response: AuthenticatorAttestationResponseJSON,
		authenticatorAttachment: v.optional(v.picklist(['cross-platform', 'platform'])),
		clientExtensionResults: AuthenticationExtensionsClientOutputs,
		type: v.literal('public-key'),
	}),
	v.metadata({ ref: 'RegistrationResponseJSON' }),
);

/** AuthenticationResponseJSON — body from startAuthentication() */
export const AuthenticationResponseJSON = v.pipe(
	v.object({
		id: v.string(),
		rawId: v.string(),
		response: AuthenticatorAssertionResponseJSON,
		authenticatorAttachment: v.optional(v.picklist(['cross-platform', 'platform'])),
		clientExtensionResults: AuthenticationExtensionsClientOutputs,
		type: v.literal('public-key'),
	}),
	v.metadata({ ref: 'AuthenticationResponseJSON' }),
);

// ── Response schemas ─────────────────────────────────────────────────────────

const PasskeyItem = v.pipe(
	v.object({
		id: v.string(),
		name: v.nullable(v.string()),
		createdAt: v.number(),
	}),
	v.metadata({ ref: 'PasskeyItem' }),
);

const BackupCodeStatus = v.pipe(
	v.object({
		count: v.number(),
		remaining: v.number(),
	}),
	v.metadata({ ref: 'BackupCodeStatus' }),
);

const PublicKeyCredentialCreationOptionsJSON = v.pipe(
  // このunknownは仕方がない
	v.record(v.string(), v.unknown()),
	v.metadata({ ref: 'PublicKeyCredentialCreationOptionsJSON' }),
);

const PublicKeyCredentialRequestOptionsJSON = v.pipe(
	v.record(v.string(), v.unknown()),
	v.metadata({ ref: 'PublicKeyCredentialRequestOptionsJSON' }),
);

// ── API definition ───────────────────────────────────────────────────────────

export const passkeyApiDef = {
	'/api/passkey/register/begin': {
		summary: 'Begin passkey registration',
		tags: ['passkey'],
		req: v.object({}),
		res: {
			200: { description: 'Registration options', content: { 'application/json': { vSchema: v.object({ challengeId: v.string(), options: PublicKeyCredentialCreationOptionsJSON }) } } },
			401: { description: 'Unauthorized', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/register/finish': {
		summary: 'Finish passkey registration',
		tags: ['passkey'],
		req: v.object({
			challengeId: v.string(),
			credential: RegistrationResponseJSON,
			name: v.optional(v.pipe(v.string(), v.maxLength(64))),
		}),
		res: {
			200: { description: 'Registration successful', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request or verification failed', content: { 'application/json': { vSchema: ErrorResponse } } },
			401: { description: 'Unauthorized', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/authenticate/begin': {
		summary: 'Begin passkey authentication',
		tags: ['passkey'],
		req: v.object({}),
		res: {
			200: { description: 'Authentication options', content: { 'application/json': { vSchema: v.object({ challengeId: v.string(), options: PublicKeyCredentialRequestOptionsJSON }) } } },
		},
	},
	'/api/passkey/authenticate/finish': {
		summary: 'Finish passkey authentication',
		tags: ['passkey'],
		req: v.object({
			challengeId: v.string(),
			credential: AuthenticationResponseJSON,
		}),
		res: {
			200: { description: 'Authentication successful', content: { 'application/json': { vSchema: v.object({ token: v.string() }) } } },
			400: { description: 'Bad request or invalid challenge', content: { 'application/json': { vSchema: ErrorResponse } } },
			401: { description: 'Authentication failed', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/list': {
		summary: 'List registered passkeys',
		tags: ['passkey'],
		req: v.object({}),
		res: {
			200: { description: 'Passkey list', content: { 'application/json': { vSchema: v.array(PasskeyItem) } } },
			401: { description: 'Unauthorized', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/delete': {
		summary: 'Delete a passkey',
		tags: ['passkey'],
		req: v.object({
			passkeyId: v.string(),
		}),
		res: {
			200: { description: 'Deleted', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			401: { description: 'Unauthorized', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/backup-codes/generate': {
		summary: 'Generate new backup codes',
		tags: ['passkey'],
		req: v.object({}),
		res: {
			200: { description: 'Backup codes generated', content: { 'application/json': { vSchema: v.object({ codes: v.array(v.string()) }) } } },
			401: { description: 'Unauthorized', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/backup-codes/status': {
		summary: 'Get backup code status',
		tags: ['passkey'],
		req: v.object({}),
		res: {
			200: { description: 'Backup code status', content: { 'application/json': { vSchema: BackupCodeStatus } } },
			401: { description: 'Unauthorized', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/backup-codes/use': {
		summary: 'Login with a backup code',
		tags: ['passkey'],
		req: v.object({
			username: v.string(),
			password: v.string(),
			code: v.string(),
		}),
		res: {
			200: { description: 'Login successful', content: { 'application/json': { vSchema: v.object({ token: v.string() }) } } },
			400: { description: 'Bad request', content: { 'application/json': { vSchema: ErrorResponse } } },
			401: { description: 'Invalid credentials or code', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/signup/begin': {
		summary: 'Begin passkey signup',
		tags: ['passkey'],
		req: v.object({
			username: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
			passphrase: v.optional(v.string()),
		}),
		res: {
			200: { description: 'Signup options', content: { 'application/json': { vSchema: v.object({ challengeId: v.string(), options: PublicKeyCredentialCreationOptionsJSON }) } } },
			400: { description: 'Bad request or invalid username', content: { 'application/json': { vSchema: ErrorResponse } } },
			403: { description: 'Forbidden (invalid passphrase or registration closed)', content: { 'application/json': { vSchema: ErrorResponse } } },
			409: { description: 'Username already taken', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/signup/finish': {
		summary: 'Finish passkey signup',
		tags: ['passkey'],
		req: v.object({
			challengeId: v.string(),
			credential: RegistrationResponseJSON,
			passkeyName: v.optional(v.pipe(v.string(), v.maxLength(64))),
		}),
		res: {
			200: { description: 'Account created and token issued', content: { 'application/json': { vSchema: v.object({ token: v.string() }) } } },
			400: { description: 'Bad request or verification failed', content: { 'application/json': { vSchema: ErrorResponse } } },
			409: { description: 'Username already taken', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
