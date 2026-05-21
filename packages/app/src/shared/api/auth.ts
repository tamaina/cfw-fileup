import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';
import { nameFormatValidation } from '../name-validation.js';
import { MAX_PASSPHRASE_LENGTH, MAX_TURNSTILE_TOKEN_LENGTH, MAX_USERNAME_LENGTH } from '../const.js';

export const authApiDef = {
	'/api/signup': {
		summary: 'Sign up',
		tags: ['auth'],
		req: v.object({
			username: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_USERNAME_LENGTH), nameFormatValidation),
			password: v.pipe(v.string(), v.minLength(8), v.maxLength(MAX_PASSPHRASE_LENGTH)),
			passphrase: v.optional(v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH))),
			turnstileToken: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURNSTILE_TOKEN_LENGTH))),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ userId: v.string(), token: v.string() }) } } },
			400: { description: 'Bad request (missing fields, invalid username/password, or Turnstile failure)', content: { 'application/json': { vSchema: ErrorResponse } } },
			403: { description: 'Forbidden (invalid passphrase or registration closed)', content: { 'application/json': { vSchema: ErrorResponse } } },
			409: { description: 'Username already exists', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/signin': {
		summary: 'Sign in',
		tags: ['auth'],
		req: v.object({
			username: v.pipe(v.string(), v.maxLength(MAX_USERNAME_LENGTH)),
			password: v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH)),
			backupCode: v.optional(v.pipe(v.string(), v.maxLength(128))),
			turnstileToken: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURNSTILE_TOKEN_LENGTH))),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ token: v.string() }) } } },
			400: { description: 'Bad request (missing fields or Turnstile failure)', content: { 'application/json': { vSchema: ErrorResponse } } },
			401: { description: 'Invalid credentials or account suspended', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
