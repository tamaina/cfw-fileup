/**
 * OpenAPI 3.0.0 specification generator
 * Collects schemas and routes to generate comprehensive API documentation
 */

import type { Schema } from './api/schema-type';

interface OpenAPISchema {
	type?: string;
	properties?: Record<string, any>;
	required?: string[];
	items?: any;
	description?: string;
	enum?: any[];
	format?: string;
	[key: string]: any;
}

interface OpenAPIParameter {
	name: string;
	in: 'path' | 'query' | 'header' | 'cookie';
	required?: boolean;
	schema: OpenAPISchema;
	description?: string;
}

interface OpenAPIResponse {
	description: string;
	content?: {
		'application/json': {
			schema: OpenAPISchema;
		};
	};
}

interface OpenAPIOperation {
	summary?: string;
	description?: string;
	operationId?: string;
	parameters?: OpenAPIParameter[];
	requestBody?: {
		required?: boolean;
		content: {
			'application/json': {
				schema: OpenAPISchema;
			};
		};
	};
	responses: Record<string, OpenAPIResponse>;
	security?: Array<Record<string, string[]>>;
	tags?: string[];
}

interface OpenAPIPath {
	[method: string]: OpenAPIOperation;
}

// Schemas imported from API files
const schemas: Record<string, Schema> = {
	SignupResponse: {
		type: 'object',
		properties: {
			userId: { type: 'string', description: 'User ID (EAID-X format)' },
			token: { type: 'string', description: 'Authentication token' },
		},
		required: ['userId', 'token'],
	} as const,

	SigninResponse: {
		type: 'object',
		properties: {
			token: { type: 'string', description: 'Authentication token' },
		},
		required: ['token'],
	} as const,

	UserProfile: {
		type: 'object',
		properties: {
			id: { type: 'string', description: 'User ID' },
			username: { type: 'string', description: 'Username' },
			isAdmin: { type: 'boolean', description: 'Admin status' },
			isSuspended: { type: 'boolean', description: 'Suspension status' },
		},
		required: ['id', 'username', 'isAdmin', 'isSuspended'],
	} as const,

	Bucket: {
		type: 'object',
		properties: {
			id: { type: 'string', description: 'Bucket ID' },
			name: { type: 'string', description: 'Bucket name' },
			userId: { type: 'string', description: 'Owner user ID' },
		},
		required: ['id', 'name', 'userId'],
	} as const,

	CreateBucketResponse: {
		type: 'object',
		properties: {
			bucketId: { type: 'string', description: 'Newly created bucket ID' },
		},
		required: ['bucketId'],
	} as const,

	ListBucketsResponse: {
		type: 'object',
		properties: {
			buckets: {
				type: 'array',
				items: { $ref: '#/components/schemas/Bucket' },
				description: 'List of buckets',
			},
		},
		required: ['buckets'],
	} as const,

	File: {
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
	} as const,

	CreateOpenFileResponse: {
		type: 'object',
		properties: {
			fileId: { type: 'string', description: 'File ID for upload' },
			uploadExpiry: { type: 'number', description: 'Upload expiration timestamp' },
		},
		required: ['fileId', 'uploadExpiry'],
	} as const,

	OkResponse: {
		type: 'object',
		properties: {
			ok: { type: 'boolean', description: 'Operation successful' },
		},
		required: ['ok'],
	} as const,

	AppSetting: {
		type: 'object',
		properties: {
			key: { type: 'string', description: 'Setting key' },
			value: { type: 'string', description: 'Setting value' },
		},
		required: ['key', 'value'],
	} as const,

	GetSettingsResponse: {
		type: 'array',
		items: { $ref: '#/components/schemas/AppSetting' },
		description: 'List of application settings',
	} as const,

	UpdateSettingResponse: {
		type: 'object',
		properties: {
			key: { type: 'string', description: 'Updated setting key' },
			value: { type: 'string', description: 'Updated setting value' },
		},
		required: ['key', 'value'],
	} as const,

	Quota: {
		type: 'object',
		properties: {
			maxBuckets: { type: 'integer', nullable: true, description: 'Max buckets per user' },
			maxBucketSizeBytes: { type: 'integer', nullable: true, description: 'Max bucket size in bytes' },
			maxFilesPerBucket: { type: 'integer', nullable: true, description: 'Max files per bucket' },
			maxDailyUploads: { type: 'integer', nullable: true, description: 'Max daily uploads' },
		},
		required: ['maxBuckets', 'maxBucketSizeBytes', 'maxFilesPerBucket', 'maxDailyUploads'],
	} as const,

	MetaResponse: {
		type: 'object',
		properties: {
			registrationEnabled: { type: 'boolean', description: 'Whether new user registration is enabled' },
			passphraseRequired: { type: 'boolean', description: 'Whether signup passphrase is required' },
		},
		required: ['registrationEnabled', 'passphraseRequired'],
	} as const,

	ErrorResponse: {
		type: 'object',
		properties: {
			message: { type: 'string', description: 'Error message' },
		},
		required: ['message'],
	} as const,
};

function schemaToOpenAPI(schema: any): OpenAPISchema {
	if (schema.$ref) {
		return schema;
	}
	if (schema.type === 'array') {
		return {
			type: 'array',
			items: schemaToOpenAPI(schema.items),
			description: schema.description,
		};
	}
	if (schema.type === 'object') {
		const properties: Record<string, any> = {};
		if (schema.properties) {
			for (const [key, prop] of Object.entries(schema.properties)) {
				properties[key] = schemaToOpenAPI(prop as any);
			}
		}
		return {
			type: 'object',
			properties,
			required: schema.required,
			description: schema.description,
		};
	}
	return schema;
}

export function generateOpenAPISpec(): Record<string, any> {
	const paths: Record<string, OpenAPIPath> = {};

	// Auth endpoints
	paths['/api/signup'] = {
		post: {
			summary: 'User registration',
			operationId: 'signup',
			tags: ['Authentication'],
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								username: { type: 'string', minLength: 1, maxLength: 32 },
								password: { type: 'string', minLength: 8 },
								passphrase: { type: 'string', optional: true },
							},
							required: ['username', 'password'],
						},
					},
				},
			},
			responses: {
				'200': {
					description: 'User created successfully',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.SignupResponse),
						},
					},
				},
				'400': {
					description: 'Invalid request',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'403': {
					description: 'Forbidden (invalid passphrase or registration closed)',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'409': {
					description: 'Username already exists',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
			},
		},
	};

	paths['/api/signin'] = {
		post: {
			summary: 'User login',
			operationId: 'signin',
			tags: ['Authentication'],
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								username: { type: 'string' },
								password: { type: 'string' },
							},
							required: ['username', 'password'],
						},
					},
				},
			},
			responses: {
				'200': {
					description: 'Login successful',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.SigninResponse),
						},
					},
				},
				'401': {
					description: 'Invalid credentials',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
			},
		},
	};

	// Bucket endpoints
	paths['/api/buckets/create'] = {
		post: {
			summary: 'Create a new bucket',
			operationId: 'createBucket',
			tags: ['Buckets'],
			security: [{ BearerAuth: [] }],
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								bucketName: { type: 'string', minLength: 1, maxLength: 64 },
							},
							required: ['bucketName'],
						},
					},
				},
			},
			responses: {
				'200': {
					description: 'Bucket created successfully',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.CreateBucketResponse),
						},
					},
				},
				'400': {
					description: 'Invalid request',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'401': {
					description: 'Unauthorized',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'409': {
					description: 'Bucket name already exists',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'429': {
					description: 'Quota exceeded',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
			},
		},
	};

	paths['/api/buckets/delete'] = {
		post: {
			summary: 'Delete a bucket',
			operationId: 'deleteBucket',
			tags: ['Buckets'],
			security: [{ BearerAuth: [] }],
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								bucketId: { type: 'string' },
							},
							required: ['bucketId'],
						},
					},
				},
			},
			responses: {
				'204': {
					description: 'Bucket deleted successfully',
				},
				'401': {
					description: 'Unauthorized',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'403': {
					description: 'Forbidden',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'404': {
					description: 'Bucket not found',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
			},
		},
	};

	// File endpoints
	paths['/api/files/create/open'] = {
		post: {
			summary: 'Create/open a file for upload',
			operationId: 'createOpenFile',
			tags: ['Files'],
			security: [{ BearerAuth: [] }],
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								bucketId: { type: 'string' },
								path: { type: 'string' },
							},
							required: ['bucketId', 'path'],
						},
					},
				},
			},
			responses: {
				'200': {
					description: 'File opened successfully',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.CreateOpenFileResponse),
						},
					},
				},
				'400': {
					description: 'Invalid request',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'401': {
					description: 'Unauthorized',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'404': {
					description: 'Bucket not found',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'429': {
					description: 'Quota exceeded',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
			},
		},
	};

	paths['/api/files/create/close'] = {
		post: {
			summary: 'Close file upload',
			operationId: 'closeFile',
			tags: ['Files'],
			security: [{ BearerAuth: [] }],
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								fileId: { type: 'string' },
								isPublic: { type: 'boolean' },
								passphrase: { type: 'string', optional: true },
							},
							required: ['fileId', 'isPublic'],
						},
					},
				},
			},
			responses: {
				'200': {
					description: 'File closed successfully',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.OkResponse),
						},
					},
				},
				'401': {
					description: 'Unauthorized',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'404': {
					description: 'File not found',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
			},
		},
	};

	// Meta endpoint
	paths['/api/meta'] = {
		get: {
			summary: 'Get server metadata',
			operationId: 'getMeta',
			tags: ['Metadata'],
			responses: {
				'200': {
					description: 'Server metadata',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.MetaResponse),
						},
					},
				},
			},
		},
	};

	// Admin endpoints
	paths['/api/admin/get-settings'] = {
		get: {
			summary: 'Get all settings (admin only)',
			operationId: 'getSettings',
			tags: ['Admin'],
			security: [{ BearerAuth: [] }],
			responses: {
				'200': {
					description: 'Settings list',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.GetSettingsResponse),
						},
					},
				},
				'401': {
					description: 'Unauthorized',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'403': {
					description: 'Forbidden (admin only)',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
			},
		},
	};

	paths['/api/admin/update-setting'] = {
		post: {
			summary: 'Update a setting (admin only)',
			operationId: 'updateSetting',
			tags: ['Admin'],
			security: [{ BearerAuth: [] }],
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								key: { type: 'string' },
								value: { type: 'string' },
							},
							required: ['key', 'value'],
						},
					},
				},
			},
			responses: {
				'200': {
					description: 'Setting updated successfully',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.UpdateSettingResponse),
						},
					},
				},
				'401': {
					description: 'Unauthorized',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
				'403': {
					description: 'Forbidden (admin only)',
					content: {
						'application/json': {
							schema: schemaToOpenAPI(schemas.ErrorResponse),
						},
					},
				},
			},
		},
	};

	// Upload endpoints
	paths['/upload/{fileId}/resume'] = {
		get: {
			summary: 'Get upload resume info (TUS protocol)',
			operationId: 'resumeGetInfo',
			tags: ['Upload'],
			security: [{ BearerAuth: [] }],
			parameters: [
				{
					name: 'fileId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
					description: 'File ID',
				},
			],
			responses: {
				'200': {
					description: 'Upload info retrieved',
					headers: {
						'Upload-Offset': {
							description: 'Current upload offset',
							schema: { type: 'string' },
						},
						'Tus-Resumable': {
							description: 'TUS protocol version',
							schema: { type: 'string' },
						},
					},
				},
				'401': {
					description: 'Unauthorized',
				},
				'403': {
					description: 'Forbidden',
				},
				'404': {
					description: 'File not found',
				},
				'410': {
					description: 'Upload expired',
				},
			},
		},
		patch: {
			summary: 'Upload file chunk (TUS protocol)',
			operationId: 'resumeUploadChunk',
			tags: ['Upload'],
			security: [{ BearerAuth: [] }],
			parameters: [
				{
					name: 'fileId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
					description: 'File ID',
				},
				{
					name: 'Upload-Offset',
					in: 'header',
					required: true,
					schema: { type: 'string' },
					description: 'Current upload offset',
				},
				{
					name: 'Content-Length',
					in: 'header',
					required: true,
					schema: { type: 'string' },
					description: 'Chunk size',
				},
			],
			requestBody: {
				required: true,
				content: {
					'application/octet-stream': {
						schema: { type: 'string', format: 'binary' },
					},
				},
			},
			responses: {
				'204': {
					description: 'Chunk uploaded successfully',
					headers: {
						'Upload-Offset': {
							description: 'New upload offset',
							schema: { type: 'string' },
						},
						'Tus-Resumable': {
							description: 'TUS protocol version',
							schema: { type: 'string' },
						},
					},
				},
				'400': {
					description: 'Invalid request (wrong offset or chunk size)',
				},
				'401': {
					description: 'Unauthorized',
				},
				'403': {
					description: 'Forbidden',
				},
				'404': {
					description: 'File not found',
				},
				'410': {
					description: 'Upload expired',
				},
			},
		},
	};

	// Build components/schemas
	const componentsSchemas: Record<string, any> = {};
	for (const [name, schema] of Object.entries(schemas)) {
		componentsSchemas[name] = schemaToOpenAPI(schema);
	}

	return {
		openapi: '3.0.0',
		info: {
			title: 'CFW FileUp API',
			description: 'File upload service powered by Cloudflare Workers',
			version: '1.0.0',
			contact: {
				name: 'tamaina',
				url: 'https://github.com/tamaina/cfw-fileup',
			},
		},
		servers: [
			{
				url: '/',
				description: 'Current server',
			},
		],
		paths,
		components: {
			schemas: componentsSchemas,
			securitySchemes: {
				BearerAuth: {
					type: 'http',
					scheme: 'bearer',
					description: 'Authentication using bearer token from signup/signin',
				},
			},
		},
		tags: [
			{ name: 'Authentication', description: 'User login and registration' },
			{ name: 'Buckets', description: 'Bucket management' },
			{ name: 'Files', description: 'File management' },
			{ name: 'Upload', description: 'TUS protocol-based file upload' },
			{ name: 'Metadata', description: 'Server information' },
			{ name: 'Admin', description: 'Admin-only operations' },
		],
	};
}
