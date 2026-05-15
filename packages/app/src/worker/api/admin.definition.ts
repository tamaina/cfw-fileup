import type { Schema } from './schema-type';

// Request schemas
export const suspendUserSchema = {
	type: 'object',
	properties: {
		userId: { type: 'string' },
	},
	required: ['userId'],
} as const satisfies Schema;

export const deleteFileAdminSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
	},
	required: ['fileId'],
} as const satisfies Schema;

export const deleteBucketAdminSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
	},
	required: ['bucketId'],
} as const satisfies Schema;

export const toggleRegistrationSchema = {
	type: 'object',
	properties: {
		enabled: { type: 'boolean' },
	},
	required: ['enabled'],
} as const satisfies Schema;

export const updateSettingSchema = {
	type: 'object',
	properties: {
		key: { type: 'string' },
		value: { type: 'string' },
	},
	required: ['key', 'value'],
} as const satisfies Schema;

// Response schemas
export const appSettingSchema = {
	type: 'object',
	properties: {
		key: { type: 'string', description: 'Setting key' },
		value: { type: 'string', description: 'Setting value' },
	},
	required: ['key', 'value'],
} as const satisfies Schema;

export const getSettingsResponseSchema = {
	type: 'array',
	items: { ref: 'AppSetting' },
	description: 'List of application settings',
} as const satisfies Schema;

export const updateSettingResponseSchema = {
	type: 'object',
	properties: {
		key: { type: 'string', description: 'Updated setting key' },
		value: { type: 'string', description: 'Updated setting value' },
	},
	required: ['key', 'value'],
} as const satisfies Schema;

export const quotaSchema = {
	type: 'object',
	properties: {
		maxBuckets: { type: 'integer', nullable: true, description: 'Max buckets per user' },
		maxBucketSizeBytes: { type: 'integer', nullable: true, description: 'Max bucket size in bytes' },
		maxFilesPerBucket: { type: 'integer', nullable: true, description: 'Max files per bucket' },
		maxDailyUploads: { type: 'integer', nullable: true, description: 'Max daily uploads' },
	},
	required: ['maxBuckets', 'maxBucketSizeBytes', 'maxFilesPerBucket', 'maxDailyUploads'],
} as const satisfies Schema;

// API endpoint definitions
export const adminDefinition = {
	suspendUser: {
		request: suspendUserSchema,
		response: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
	},
	deleteFile: {
		request: deleteFileAdminSchema,
		response: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
	},
	deleteBucket: {
		request: deleteBucketAdminSchema,
		response: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
	},
	toggleRegistration: {
		request: toggleRegistrationSchema,
		response: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
	},
	setSetting: {
		request: updateSettingSchema,
		response: updateSettingResponseSchema,
	},
	getSettings: {
		response: getSettingsResponseSchema,
	},
	setUserQuota: {
		request: quotaSchema,
		response: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
	},
	setGlobalQuota: {
		request: quotaSchema,
		response: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
	},
} as const;
