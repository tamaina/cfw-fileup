import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';

export const authApiDef = {
	'/api/signup': {
		summary: 'Sign up',
		tags: ['auth'],
		req: v.object({
			username: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
			password: v.pipe(v.string(), v.minLength(8)),
			passphrase: v.optional(v.string()),
			turnstileToken: v.optional(v.string()),
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
			username: v.string(),
			password: v.string(),
			turnstileToken: v.optional(v.string()),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ token: v.string() }) } } },
			400: { description: 'Bad request (missing fields or Turnstile failure)', content: { 'application/json': { vSchema: ErrorResponse } } },
			401: { description: 'Invalid credentials or account suspended', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
