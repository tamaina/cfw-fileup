import * as v from 'valibot';

export const bucketsApiDef = {
	'/api/buckets/create': {
		req: v.object({
			bucketName: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ bucketId: v.string() }) } } },
			400: { description: 'Bad request (invalid bucket name)' },
			401: { description: 'Unauthorized' },
			409: { description: 'Bucket name already exists' },
			429: { description: 'Bucket limit exceeded' },
		},
	},
	'/api/buckets/delete': {
		req: v.object({
			bucketId: v.string(),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing bucketId)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'Bucket not found' },
		},
	},
	'/api/buckets/list': {
		req: v.object({}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({
				buckets: v.array(v.object({ id: v.string(), name: v.string(), usedBytes: v.number() })),
				maxBucketSizeBytes: v.nullable(v.number()),
			}) } } },
			401: { description: 'Unauthorized' },
		},
	},
};
