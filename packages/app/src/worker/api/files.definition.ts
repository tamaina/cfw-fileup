import type { Schema } from './schema-type';

// Request schemas
export const createOpenSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
		path: { type: 'string' },
	},
	required: ['bucketId', 'path'],
} as const satisfies Schema;

export const targzIndexSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
		files: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					mimeType: { type: 'string' },
					aStart: { type: 'integer' },
					aFirstEnd: { type: 'integer' },
					aFinalStart: { type: 'integer' },
					aEnd: { type: 'integer' },
					rStartOffset: { type: 'integer' },
					rEndOffset: { type: 'integer' },
				},
				required: ['path', 'mimeType', 'aStart', 'aFirstEnd', 'aFinalStart', 'aEnd', 'rStartOffset', 'rEndOffset'],
			},
		},
	},
	required: ['fileId', 'files'],
} as const satisfies Schema;

export const tarIndexSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
		files: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					mimeType: { type: 'string' },
					offset: { type: 'integer' },
					size: { type: 'integer' },
				},
				required: ['path', 'mimeType', 'offset', 'size'],
			},
		},
	},
	required: ['fileId', 'files'],
} as const satisfies Schema;

export const createCloseSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
		isPublic: { type: 'boolean' },
		passphrase: { type: 'string', optional: true },
	},
	required: ['fileId', 'isPublic'],
} as const satisfies Schema;

export const deleteFileSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
		path: { type: 'string' },
	},
	required: ['bucketId', 'path'],
} as const satisfies Schema;

// Response schemas
export const fileSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'File ID' },
		path: { type: 'string', description: 'File path in bucket' },
		bucketId: { type: 'string', description: 'Bucket ID' },
		userId: { type: 'string', description: 'Owner user ID' },
		size: { type: 'number', nullable: true, description: 'File size in bytes' },
		mimeType: { type: 'string', nullable: true, description: 'MIME type' },
		isPublic: { type: 'boolean', description: 'Public accessibility' },
		uploadExpiresAt: { type: 'number', description: 'Upload expiration timestamp' },
		isClosed: { type: 'boolean', description: 'Upload completion status' },
		isTargz: { type: 'boolean', description: 'tar.gz indexed file' },
		isTar: { type: 'boolean', description: 'tar indexed file' },
	},
	required: ['id', 'path', 'bucketId', 'userId', 'isPublic', 'uploadExpiresAt', 'isClosed', 'isTargz', 'isTar'],
} as const satisfies Schema;

export const createOpenFileResponseSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string', description: 'File ID for upload' },
		uploadExpiry: { type: 'number', description: 'Upload expiration timestamp' },
	},
	required: ['fileId', 'uploadExpiry'],
} as const satisfies Schema;

export const okResponseSchema = {
	type: 'object',
	properties: {
		ok: { type: 'boolean', description: 'Operation successful' },
	},
	required: ['ok'],
} as const satisfies Schema;

// API endpoint definitions
export const filesDefinition = {
	createOpen: {
		request: createOpenSchema,
		response: createOpenFileResponseSchema,
	},
	createTargzIndex: {
		request: targzIndexSchema,
		response: okResponseSchema,
	},
	createTarIndex: {
		request: tarIndexSchema,
		response: okResponseSchema,
	},
	createClose: {
		request: createCloseSchema,
		response: okResponseSchema,
	},
	delete: {
		request: deleteFileSchema,
		response: okResponseSchema,
	},
} as const;
