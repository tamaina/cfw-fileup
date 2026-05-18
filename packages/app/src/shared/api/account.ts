import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.js';

export const accountApiDef = {
	'/api/account/me': {
    summary: 'Get account info from authentication information',
    tags: ['account'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ id: v.string(), username: v.string(), isAdmin: v.boolean() }) } } },
			401: { description: 'Unauthorized' },
		},
	},
	'/api/account/update': {
    summary: 'Update account info',
    tags: ['account'],
		req: v.object({
			username: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
			newPassword: v.optional(v.pipe(v.string(), v.minLength(8))),
			currentPassword: v.string(),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing currentPassword or password too short)' },
			401: { description: 'Invalid current password' },
			404: { description: 'User not found' },
			409: { description: 'Username already exists' },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
