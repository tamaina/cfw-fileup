import * as v from 'valibot';
import { ErrorResponse, IdString } from '../api.schemas.js';
import { KnownSettingListSchema, KnownSettingRecordSchema } from '../app-settings.js';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';

const QuotaResponse = v.pipe(
	v.object({
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
	}),
	v.metadata({ ref: 'Quota' }),
);
const QuotaInput = {
	maxBuckets: v.optional(v.nullable(v.number())),
	maxBucketSizeBytes: v.optional(v.nullable(v.number())),
	maxFilesPerBucket: v.optional(v.nullable(v.number())),
	maxDailyUploads: v.optional(v.nullable(v.number())),
} as const;
const PlanResponse = v.pipe(
	v.object({
		id: IdString,
		name: v.string(),
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'Plan' }),
);
const UserPlanAssignmentResponse = v.pipe(
	v.object({
		userId: IdString,
		planId: IdString,
		planName: v.string(),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'UserPlanAssignment' }),
);
const NullableUserPlanAssignmentResponse = v.nullable(UserPlanAssignmentResponse);

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
			...QuotaInput,
		}),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/set-global-quota': {
		summary: 'Set global quota',
		tags: ['admin'],
		req: v.object(QuotaInput),
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
	'/api/admin/list-plans': {
		summary: 'List plans',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(PlanResponse) } } }, ...AdminErrors },
	},
	'/api/admin/create-plan': {
		summary: 'Create plan',
		tags: ['admin'],
		req: v.object({
			name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
			...QuotaInput,
		}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PlanResponse } } }, ...AdminErrors },
	},
	'/api/admin/update-plan': {
		summary: 'Update plan',
		tags: ['admin'],
		req: v.object({
			planId: IdString,
			name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
			...QuotaInput,
		}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PlanResponse } } }, ...AdminErrors, 404: { description: 'Plan not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/delete-plan': {
		summary: 'Delete plan',
		tags: ['admin'],
		req: v.object({ planId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'Plan not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/assign-user-plan': {
		summary: 'Assign plan to user',
		tags: ['admin'],
		req: v.object({
			userId: IdString,
			planId: IdString,
			expiresAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
		}),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'User or plan not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/get-user-plan': {
		summary: 'Get user plan assignment',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: NullableUserPlanAssignmentResponse } } }, ...AdminErrors, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
	'/api/admin/delete-user-plan': {
		summary: 'Delete user plan assignment',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'User not found', content: { 'application/json': { vSchema: ErrorResponse } } } },
	},
} as const satisfies ApiEndpointDefinitionRecord;
