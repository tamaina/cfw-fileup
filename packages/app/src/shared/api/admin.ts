import * as v from 'valibot';

const QuotaResponse = v.pipe(
	v.object({
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
	}),
	v.metadata({ ref: 'Quota' }),
);

const OkResponse = { 200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } } };
const AdminErrors = { 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden (admin only)' } };

export const adminApiDef = {
	'/api/admin/suspend-user': {
		req: v.object({ userId: v.string() }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing userId)' }, 404: { description: 'User not found' } },
	},
	'/api/admin/delete-file': {
		req: v.object({ fileId: v.string() }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing fileId)' }, 404: { description: 'File not found' } },
	},
	'/api/admin/delete-bucket': {
		req: v.object({ bucketId: v.string() }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (missing bucketId)' }, 404: { description: 'Bucket not found' } },
	},
	'/api/admin/set-user-quota/:userId': {
		req: v.object({
			maxBuckets: v.optional(v.nullable(v.number())),
			maxBucketSizeBytes: v.optional(v.nullable(v.number())),
			maxFilesPerBucket: v.optional(v.nullable(v.number())),
			maxDailyUploads: v.optional(v.nullable(v.number())),
		}),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'User not found' } },
	},
	'/api/admin/set-global-quota': {
		req: v.object({
			maxBuckets: v.optional(v.nullable(v.number())),
			maxBucketSizeBytes: v.optional(v.nullable(v.number())),
			maxFilesPerBucket: v.optional(v.nullable(v.number())),
			maxDailyUploads: v.optional(v.nullable(v.number())),
		}),
		res: { ...OkResponse, ...AdminErrors },
	},
	'/api/admin/get-user-quota/:userId': {
		req: v.object({}),
		res: { 200: { content: { 'application/json': { vSchema: QuotaResponse } } }, ...AdminErrors, 404: { description: 'User not found' } },
	},
	'/api/admin/get-global-quota': {
		req: v.object({}),
		res: { 200: { content: { 'application/json': { vSchema: QuotaResponse } } }, ...AdminErrors },
	},
	'/api/admin/delete-user-quota/:userId': {
		req: v.object({}),
		res: { ...OkResponse, ...AdminErrors, 404: { description: 'User not found' } },
	},
	'/api/admin/list-users': {
		req: v.object({}),
		res: { 200: { content: { 'application/json': { vSchema: v.array(v.object({ id: v.string(), username: v.string(), isAdmin: v.boolean(), isSuspended: v.boolean() })) } } }, ...AdminErrors },
	},
	'/api/admin/toggle-registration': {
		req: v.object({ enabled: v.boolean() }),
		res: { ...OkResponse, ...AdminErrors },
	},
	'/api/admin/update-setting': {
		req: v.object({ key: v.string(), value: v.string() }),
		res: { ...OkResponse, ...AdminErrors, 400: { description: 'Bad request (unknown setting key or invalid value)' } },
	},
	'/api/admin/get-settings': {
		req: v.object({}),
		res: { 200: { content: { 'application/json': { vSchema: v.array(v.object({ key: v.string(), value: v.string() })) } } }, ...AdminErrors },
	},
};
