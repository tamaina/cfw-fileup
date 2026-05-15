import type { Schema } from './schema-type';

const createBucketSchema = {
	type: 'object',
	properties: {
		bucketName: { type: 'string', minLength: 1, maxLength: 64 },
	},
	required: ['bucketName'],
} as const satisfies Schema;

const deleteBucketSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
	},
	required: ['bucketId'],
} as const satisfies Schema;

const bucketSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'Bucket ID' },
		name: { type: 'string', description: 'Bucket name' },
	},
	required: ['id', 'name'],
} as const satisfies Schema;

const createBucketResponseSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string', description: 'Newly created bucket ID' },
	},
	required: ['bucketId'],
} as const satisfies Schema;

const listBucketsResponseSchema = {
	type: 'object',
	properties: {
		buckets: {
			type: 'array',
			items: bucketSchema,
		},
	},
	required: ['buckets'],
} as const satisfies Schema;

export const bucketsApiSchema = [
	{
		path: '/api/buckets/create',
		method: 'post',
		summary: 'Create bucket',
		tags: ['Buckets'],
		requestBody: {
			'application/json': createBucketSchema,
		},
		responses: {
			201: {
				description: 'Created',
				content: {
					'application/json': { schema: createBucketResponseSchema }
				}
			},
			400: { description: 'Bad request' },
			429: { description: 'Quota exceeded' },
		},
	},
	{
		path: '/api/buckets/list',
		method: 'post',
		summary: 'List buckets',
		tags: ['Buckets'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: listBucketsResponseSchema }
				}
			},
			401: { description: 'Unauthorized' },
		},
	},
	{
		path: '/api/buckets/delete',
		method: 'post',
		summary: 'Delete bucket',
		tags: ['Buckets'],
		requestBody: {
			'application/json': deleteBucketSchema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: { ok: { type: 'boolean' } },
							required: ['ok'],
						}
					}
				}
			},
			400: { description: 'Bad request' },
			403: { description: 'Forbidden' },
			404: { description: 'Not found' },
		},
	},
] as const;

const okResponseSchema = {
	type: 'object',
	properties: { ok: { type: 'boolean' } },
	required: ['ok'],
} as const satisfies Schema;

export { createBucketSchema, deleteBucketSchema, bucketSchema, createBucketResponseSchema, listBucketsResponseSchema, okResponseSchema };
