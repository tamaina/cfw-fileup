import type { Schema } from './schema-type';

export const bucketsApiSchema = [
	{
		path: '/api/buckets/create',
		method: 'post',
		summary: 'Create bucket',
		tags: ['Buckets'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					bucketName: { type: 'string', minLength: 1, maxLength: 64 },
				},
				required: ['bucketName'],
			} as const satisfies Schema,
		},
		responses: {
			201: {
				description: 'Created',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								bucketId: { type: 'string', description: 'Newly created bucket ID' },
							},
							required: ['bucketId'],
						} as const satisfies Schema
					}
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
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								buckets: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											id: { type: 'string', description: 'Bucket ID' },
											name: { type: 'string', description: 'Bucket name' },
											usedBytes: { type: 'integer', description: 'Total bytes used in this bucket' },
										},
										required: ['id', 'name', 'usedBytes'],
									} as const satisfies Schema,
								},
								maxBucketSizeBytes: { type: 'integer', nullable: true, description: 'Max bucket size in bytes from quota' },
							},
							required: ['buckets', 'maxBucketSizeBytes'],
						} as const satisfies Schema
					}
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
			'application/json': {
				type: 'object',
				properties: {
					bucketId: { type: 'string' },
				},
				required: ['bucketId'],
			} as const satisfies Schema,
		},
		responses: {
			200: { description: 'Success', schema: { ref: 'OkResponse' } },
			400: { description: 'Bad request' },
			403: { description: 'Forbidden' },
			404: { description: 'Not found' },
		},
	},
] as const;
