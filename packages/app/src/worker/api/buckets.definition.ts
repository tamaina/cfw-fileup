import type { Schema } from './schema-type';

// Request schemas
export const createBucketSchema = {
	type: 'object',
	properties: {
		bucketName: { type: 'string', minLength: 1, maxLength: 64 },
	},
	required: ['bucketName'],
} as const satisfies Schema;

export const deleteBucketSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
	},
	required: ['bucketId'],
} as const satisfies Schema;

// Response schemas
export const bucketSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'Bucket ID' },
		name: { type: 'string', description: 'Bucket name' },
		userId: { type: 'string', description: 'Owner user ID' },
	},
	required: ['id', 'name', 'userId'],
} as const satisfies Schema;

export const createBucketResponseSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string', description: 'Newly created bucket ID' },
	},
	required: ['bucketId'],
} as const satisfies Schema;

export const listBucketsResponseSchema = {
	type: 'object',
	properties: {
		buckets: {
			type: 'array',
			items: { ref: 'Bucket' },
			description: 'List of buckets',
		},
	},
	required: ['buckets'],
} as const satisfies Schema;

// API endpoint definitions
export const bucketsDefinition = {
	create: {
		request: createBucketSchema,
		response: createBucketResponseSchema,
	},
	list: {
		response: listBucketsResponseSchema,
	},
	delete: {
		request: deleteBucketSchema,
		response: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
	},
} as const;
