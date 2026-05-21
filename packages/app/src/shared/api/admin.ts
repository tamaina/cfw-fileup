import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse, IdString } from '../api.schemas.js';
import { KnownSettingListSchema, KnownSettingRecordSchema } from '../app-settings.js';

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
const WorkerCachePurgeResponse = v.pipe(
	v.object({
		ok: v.literal(true),
		version: v.string(),
	}),
	v.metadata({ ref: 'WorkerCachePurgeResponse' }),
);
const AdminErrors = {};

export const adminApiDef = {
	'/api/admin/suspend-user': {
		summary: 'Suspend a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing userId)', content: { 'application/json': { vSchema: ErrorResponse } } }, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/unsuspend-user': {
		summary: 'Unsuspend a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing userId)', content: { 'application/json': { vSchema: ErrorResponse } } }, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/make-admin': {
		summary: 'Make a user an admin',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing userId)', content: { 'application/json': { vSchema: ErrorResponse } } }, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/delete-file': {
		summary: 'Delete a file',
		tags: ['admin'],
		req: v.object({ fileId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing fileId)', content: { 'application/json': { vSchema: ErrorResponse } } }, 404: { description: 'File not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/delete-bucket': {
		summary: 'Delete a bucket',
		tags: ['admin'],
		req: v.object({ bucketId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing bucketId)', content: { 'application/json': { vSchema: ErrorResponse } } }, 404: { description: 'Bucket not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/purge-worker-cache': {
		summary: 'Purge Worker cache',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: WorkerCachePurgeResponse } } }, ...AdminErrors },
	},
	'/api/admin/set-user-quota': {
		summary: 'Set quota for a user',
		tags: ['admin'],
		req: v.object({
			userId: IdString,
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
	'/api/admin/get-user-quota': {
		summary: 'Get quota for a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: QuotaResponse } } }, ...AdminErrors, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/get-global-quota': {
		summary: 'Get global quota',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: QuotaResponse } } }, ...AdminErrors },
	},
	'/api/admin/delete-user-quota': {
		summary: 'Delete user quota (reset to global)',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/list-users': {
		summary: 'List all users',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(v.object({ id: v.string(), username: v.string(), isAdmin: v.boolean(), isSuspended: v.boolean() })) } } }, ...AdminErrors },
	},
	'/api/admin/update-setting': {
		summary: 'Update app setting',
		tags: ['admin'],
		req: KnownSettingRecordSchema,
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (unknown setting key or invalid value)', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/get-settings': {
		summary: 'Get all app settings',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: KnownSettingListSchema } } }, ...AdminErrors },
	},
} as const satisfies ApiEndpointDefinitionRecord;
