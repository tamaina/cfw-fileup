import type { Schema } from './schema-type';

// All quota fields are optional — callers may omit any field to leave it
// unchanged (treated as null / no limit by the handler).
const quotaSchema = {
	type: 'object',
	properties: {
		maxBuckets: { type: 'integer', nullable: true, optional: true, description: 'Max buckets per user' },
		maxBucketSizeBytes: { type: 'integer', nullable: true, optional: true, description: 'Max bucket size in bytes' },
		maxFilesPerBucket: { type: 'integer', nullable: true, optional: true, description: 'Max files per bucket' },
		maxDailyUploads: { type: 'integer', nullable: true, optional: true, description: 'Max daily uploads' },
	},
} as const satisfies Schema;

export const adminApiSchema = [
	{
		path: '/api/admin/suspend-user',
		method: 'post',
		summary: 'Suspend user',
		tags: ['Admin'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					userId: { type: 'string' },
				},
				required: ['userId'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'OkResponse' } },
				},
			},
			400: { description: 'Bad request' },
			404: { description: 'Not found' },
		},
	},
	{
		path: '/api/admin/delete-file',
		method: 'post',
		summary: 'Delete file (admin)',
		tags: ['Admin'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					fileId: { type: 'string' },
				},
				required: ['fileId'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'OkResponse' } },
				},
			},
			400: { description: 'Bad request' },
			404: { description: 'Not found' },
		},
	},
	{
		path: '/api/admin/delete-bucket',
		method: 'post',
		summary: 'Delete bucket (admin)',
		tags: ['Admin'],
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
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'OkResponse' } },
				},
			},
			400: { description: 'Bad request' },
			404: { description: 'Not found' },
		},
	},
	{
		path: '/api/admin/update-setting',
		method: 'post',
		summary: 'Update setting',
		tags: ['Admin'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					key: { type: 'string' },
					value: { type: 'string' },
				},
				required: ['key', 'value'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'OkResponse' } },
				},
			},
			400: { description: 'Bad request' },
		},
	},
	{
		path: '/api/admin/get-settings',
		method: 'get',
		summary: 'Get all settings',
		tags: ['Admin'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'AppSettings' } },
				},
			},
		},
	},
	{
		path: '/api/admin/set-user-quota/:userId',
		method: 'post',
		summary: 'Set user quota',
		tags: ['Admin'],
		requestBody: {
			'application/json': quotaSchema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'OkResponse' } },
				},
			},
			400: { description: 'Bad request' },
			404: { description: 'Not found' },
		},
	},
	{
		path: '/api/admin/set-global-quota',
		method: 'post',
		summary: 'Set global quota',
		tags: ['Admin'],
		requestBody: {
			'application/json': quotaSchema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'OkResponse' } },
				},
			},
			400: { description: 'Bad request' },
		},
	},
	{
		path: '/api/admin/get-user-quota/:userId',
		method: 'get',
		summary: 'Get user quota',
		tags: ['Admin'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'Quota' } },
				},
			},
			404: { description: 'Not found' },
		},
	},
	{
		path: '/api/admin/get-global-quota',
		method: 'get',
		summary: 'Get global quota',
		tags: ['Admin'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'Quota' } },
				},
			},
		},
	},
	{
		path: '/api/admin/delete-user-quota/:userId',
		method: 'post',
		summary: 'Delete user quota',
		tags: ['Admin'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'OkResponse' } },
				},
			},
			404: { description: 'Not found' },
		},
	},
	{
		path: '/api/admin/list-users',
		method: 'get',
		summary: 'List all users',
		tags: ['Admin'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'UserList' } },
				},
			},
		},
	},
	{
		path: '/api/admin/toggle-registration',
		method: 'post',
		summary: 'Toggle registration',
		tags: ['Admin'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					enabled: { type: 'boolean' },
				},
				required: ['enabled'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { ref: 'OkResponse' } },
				},
			},
			400: { description: 'Bad request' },
		},
	},
] as const;
