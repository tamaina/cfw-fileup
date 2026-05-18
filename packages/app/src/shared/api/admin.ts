import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';

const QuotaResponse = v.pipe(
	v.object({
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
	}),
	v.metadata({ ref: 'Quota' }),
);

const OkResponse = { 200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } } };
const AdminErrors = {};

export const adminApiDef = {
	'/api/admin/suspend-user': {
		summary: 'Suspend a user',
		tags: ['admin'],
		req: v.object({ userId: v.string() }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing userId)', content: { 'application/json': { vSchema: ErrorResponse } } }, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/delete-file': {
		summary: 'Delete a file',
		tags: ['admin'],
		req: v.object({ fileId: v.string() }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing fileId)', content: { 'application/json': { vSchema: ErrorResponse } } }, 404: { description: 'File not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/delete-bucket': {
		summary: 'Delete a bucket',
		tags: ['admin'],
		req: v.object({ bucketId: v.string() }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing bucketId)', content: { 'application/json': { vSchema: ErrorResponse } } }, 404: { description: 'Bucket not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/set-user-quota/:userId': {
		summary: 'Set quota for a user',
		tags: ['admin'],
		req: v.object({
			maxBuckets: v.optional(v.nullable(v.number())),
			maxBucketSizeBytes: v.optional(v.nullable(v.number())),
			maxFilesPerBucket: v.optional(v.nullable(v.number())),
			maxDailyUploads: v.optional(v.nullable(v.number())),
		}),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/set-global-quota': {
		summary: 'Set global quota',
		tags: ['admin'],
		req: v.object({
			maxBuckets: v.optional(v.nullable(v.number())),
			maxBucketSizeBytes: v.optional(v.nullable(v.number())),
			maxFilesPerBucket: v.optional(v.nullable(v.number())),
			maxDailyUploads: v.optional(v.nullable(v.number())),
		}),
		res: { ...OkResponse, ...AdminErrors },
	},
	'/api/admin/get-user-quota/:userId': {
		summary: 'Get quota for a user',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: QuotaResponse } } }, ...AdminErrors, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/get-global-quota': {
		summary: 'Get global quota',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: QuotaResponse } } }, ...AdminErrors },
	},
	'/api/admin/delete-user-quota/:userId': {
		summary: 'Delete user quota (reset to global)',
		tags: ['admin'],
		req: v.object({}),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/list-users': {
		summary: 'List all users',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(v.object({ id: v.string(), username: v.string(), isAdmin: v.boolean(), isSuspended: v.boolean() })) } } }, ...AdminErrors },
	},
	'/api/admin/toggle-registration': {
		summary: 'Toggle user registration',
		tags: ['admin'],
		req: v.object({ enabled: v.boolean() }),
		res: { ...OkResponse, ...AdminErrors },
	},
	'/api/admin/update-setting': {
		summary: 'Update app setting',
		tags: ['admin'],
		req: v.object({ key: v.string(), value: v.string() }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (unknown setting key or invalid value)', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/get-settings': {
		summary: 'Get all app settings',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(v.object({ key: v.string(), value: v.string() })) } } }, ...AdminErrors },
	},
} as const satisfies ApiEndpointDefinitionRecord;
