import type { Schema } from './schema-type';

const suspendUserSchema = {
	type: 'object',
	properties: {
		userId: { type: 'string' },
	},
	required: ['userId'],
} as const satisfies Schema;

const deleteFileAdminSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
	},
	required: ['fileId'],
} as const satisfies Schema;

const deleteBucketAdminSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
	},
	required: ['bucketId'],
} as const satisfies Schema;

const toggleRegistrationSchema = {
	type: 'object',
	properties: {
		enabled: { type: 'boolean' },
	},
	required: ['enabled'],
} as const satisfies Schema;

const updateSettingSchema = {
	type: 'object',
	properties: {
		key: { type: 'string' },
		value: { type: 'string' },
	},
	required: ['key', 'value'],
} as const satisfies Schema;

const appSettingSchema = {
	type: 'object',
	properties: {
		key: { type: 'string', description: 'Setting key' },
		value: { type: 'string', description: 'Setting value' },
	},
	required: ['key', 'value'],
} as const satisfies Schema;

const getSettingsResponseSchema = {
	type: 'array',
	items: appSettingSchema,
} as const satisfies Schema;

const okResponseSchema = {
	type: 'object',
	properties: { ok: { type: 'boolean' } },
	required: ['ok'],
} as const satisfies Schema;

const quotaSchema = {
	type: 'object',
	properties: {
		maxBuckets: { type: 'integer', nullable: true, description: 'Max buckets per user' },
		maxBucketSizeBytes: { type: 'integer', nullable: true, description: 'Max bucket size in bytes' },
		maxFilesPerBucket: { type: 'integer', nullable: true, description: 'Max files per bucket' },
		maxDailyUploads: { type: 'integer', nullable: true, description: 'Max daily uploads' },
	},
	required: ['maxBuckets', 'maxBucketSizeBytes', 'maxFilesPerBucket', 'maxDailyUploads'],
} as const satisfies Schema;

export const adminApiSchema = [
	{
		path: '/api/admin/suspend-user',
		method: 'post',
		summary: 'Suspend user',
		tags: ['Admin'],
		requestBody: {
			'application/json': suspendUserSchema,
		},
		responses: {
			200: { description: 'Success', schema: okResponseSchema },
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
			'application/json': deleteFileAdminSchema,
		},
		responses: {
			200: { description: 'Success', schema: okResponseSchema },
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
			'application/json': deleteBucketAdminSchema,
		},
		responses: {
			200: { description: 'Success', schema: okResponseSchema },
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
			'application/json': updateSettingSchema,
		},
		responses: {
			200: { description: 'Success', schema: okResponseSchema },
			400: { description: 'Bad request' },
		},
	},
	{
		path: '/api/admin/get-settings',
		method: 'get',
		summary: 'Get all settings',
		tags: ['Admin'],
		responses: {
			200: { description: 'Success', schema: getSettingsResponseSchema },
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
			200: { description: 'Success', schema: okResponseSchema },
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
			200: { description: 'Success', schema: okResponseSchema },
			400: { description: 'Bad request' },
		},
	},
	{
		path: '/api/admin/get-user-quota/:userId',
		method: 'get',
		summary: 'Get user quota',
		tags: ['Admin'],
		responses: {
			200: { description: 'Success', schema: quotaSchema },
			404: { description: 'Not found' },
		},
	},
	{
		path: '/api/admin/get-global-quota',
		method: 'get',
		summary: 'Get global quota',
		tags: ['Admin'],
		responses: {
			200: { description: 'Success', schema: quotaSchema },
		},
	},
	{
		path: '/api/admin/delete-user-quota/:userId',
		method: 'post',
		summary: 'Delete user quota',
		tags: ['Admin'],
		responses: {
			200: { description: 'Success', schema: okResponseSchema },
			404: { description: 'Not found' },
		},
	},
] as const;

export { suspendUserSchema, deleteFileAdminSchema, deleteBucketAdminSchema, toggleRegistrationSchema, updateSettingSchema, appSettingSchema, quotaSchema, getSettingsResponseSchema, okResponseSchema };
