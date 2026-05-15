import type { Schema } from './schema-type';

const createOpenSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
		path: { type: 'string' },
	},
	required: ['bucketId', 'path'],
} as const satisfies Schema;

const targzIndexSchema = {
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

const tarIndexSchema = {
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

const createCloseSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
		isPublic: { type: 'boolean' },
		passphrase: { type: 'string', optional: true },
	},
	required: ['fileId', 'isPublic'],
} as const satisfies Schema;

const deleteFileSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
		path: { type: 'string' },
	},
	required: ['bucketId', 'path'],
} as const satisfies Schema;

const createOpenFileResponseSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string', description: 'File ID for upload' },
		uploadExpiry: { type: 'number', description: 'Upload expiration timestamp' },
	},
	required: ['fileId', 'uploadExpiry'],
} as const satisfies Schema;

export const filesApiSchema = [
	{
		path: '/api/files/create/open',
		method: 'post',
		summary: 'Open file for upload',
		tags: ['Files'],
		requestBody: {
			'application/json': createOpenSchema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: createOpenFileResponseSchema }
				}
			},
			400: { description: 'Bad request' },
			403: { description: 'Forbidden' },
			404: { description: 'Not found' },
			429: { description: 'Quota exceeded' },
		},
	},
	{
		path: '/api/files/create/targz-index',
		method: 'post',
		summary: 'Index tar.gz file',
		tags: ['Files'],
		requestBody: {
			'application/json': targzIndexSchema,
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
			410: { description: 'Upload expired' },
		},
	},
	{
		path: '/api/files/create/tar-index',
		method: 'post',
		summary: 'Index tar file',
		tags: ['Files'],
		requestBody: {
			'application/json': tarIndexSchema,
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
			410: { description: 'Upload expired' },
		},
	},
	{
		path: '/api/files/create/close',
		method: 'post',
		summary: 'Close file upload',
		tags: ['Files'],
		requestBody: {
			'application/json': createCloseSchema,
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
			410: { description: 'Upload expired' },
			429: { description: 'Quota exceeded' },
		},
	},
	{
		path: '/api/files/delete',
		method: 'post',
		summary: 'Delete file',
		tags: ['Files'],
		requestBody: {
			'application/json': deleteFileSchema,
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
	{
		path: '/api/files/uploadings',
		method: 'post',
		summary: 'List user files',
		tags: ['Files'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] } }
				}
			},
			401: { description: 'Unauthorized' },
		},
	},
] as const;

const okResponseSchema = {
	type: 'object',
	properties: { ok: { type: 'boolean' } },
	required: ['ok'],
} as const satisfies Schema;

export { createOpenSchema, targzIndexSchema, tarIndexSchema, createCloseSchema, deleteFileSchema, createOpenFileResponseSchema, okResponseSchema };
