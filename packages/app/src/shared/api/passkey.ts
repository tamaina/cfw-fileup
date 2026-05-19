import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';

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

export const passkeyApiDef = {
	'/api/passkey/register/begin': {
		summary: 'Begin passkey registration',
		tags: ['passkey'],
		req: v.object({}),
		res: {
			200: { description: 'Registration options', content: { 'application/json': { vSchema: v.object({ challengeId: v.string(), options: v.record(v.string(), v.unknown()) }) } } },
			401: { description: 'Unauthorized', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/register/finish': {
		summary: 'Finish passkey registration',
		tags: ['passkey'],
		req: v.object({
			challengeId: v.string(),
			credential: v.record(v.string(), v.unknown()),
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
			200: { description: 'Authentication options', content: { 'application/json': { vSchema: v.object({ challengeId: v.string(), options: v.record(v.string(), v.unknown()) }) } } },
		},
	},
	'/api/passkey/authenticate/finish': {
		summary: 'Finish passkey authentication',
		tags: ['passkey'],
		req: v.object({
			challengeId: v.string(),
			credential: v.record(v.string(), v.unknown()),
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
			code: v.string(),
		}),
		res: {
			200: { description: 'Login successful', content: { 'application/json': { vSchema: v.object({ token: v.string() }) } } },
			400: { description: 'Bad request', content: { 'application/json': { vSchema: ErrorResponse } } },
			401: { description: 'Invalid username or code', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/signup/begin': {
		summary: 'Begin passkey signup',
		tags: ['passkey'],
		req: v.object({
			username: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
		}),
		res: {
			200: { description: 'Signup options', content: { 'application/json': { vSchema: v.object({ challengeId: v.string(), options: v.record(v.string(), v.unknown()) }) } } },
			400: { description: 'Bad request or invalid username', content: { 'application/json': { vSchema: ErrorResponse } } },
			409: { description: 'Username already taken', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/passkey/signup/finish': {
		summary: 'Finish passkey signup',
		tags: ['passkey'],
		req: v.object({
			challengeId: v.string(),
			credential: v.record(v.string(), v.unknown()),
			passkeyName: v.optional(v.pipe(v.string(), v.maxLength(64))),
		}),
		res: {
			200: { description: 'Account created and token issued', content: { 'application/json': { vSchema: v.object({ token: v.string() }) } } },
			400: { description: 'Bad request or verification failed', content: { 'application/json': { vSchema: ErrorResponse } } },
			409: { description: 'Username already taken', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
