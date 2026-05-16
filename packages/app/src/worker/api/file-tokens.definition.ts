import type { Schema } from './schema-type';

export const fileTokensApiSchema = [
	{
		path: '/api/file-tokens/create',
		method: 'post',
		summary: 'Create a file access token',
		description: 'Issues an access token for a private file. Requires authentication as the bucket owner or admin. Tokens for public files cannot be created.',
		tags: ['FileTokens'],
		security: [{ bearerAuth: [] }],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					bucketName: { type: 'string', description: 'Bucket name' },
					filePath: { type: 'string', description: 'File path within the bucket' },
					expiresIn: { type: 'number', nullable: true, description: 'Seconds until expiry. null means no expiry (unlimited).' },
				},
				required: ['bucketName', 'filePath', 'expiresIn'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Token created',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								id: { type: 'string', description: 'Token ID (EAID-X)' },
								token: { type: 'string', description: 'Token value to use as ?token= query parameter' },
								expiresAt: { type: 'number', nullable: true, description: 'Expiry timestamp in ms. null means no expiry.' },
							},
							required: ['id', 'token', 'expiresAt'],
						} as const satisfies Schema,
					},
				},
			},
			400: { description: 'Bad request (missing fields, invalid expiresIn, file not closed, or file is public)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden (not owner or admin)' },
			404: { description: 'Bucket or file not found' },
		},
	},
	{
		path: '/api/file-tokens/list',
		method: 'post',
		summary: 'List file access tokens',
		description: 'Returns all issued access tokens for a file. Requires authentication as the bucket owner or admin.',
		tags: ['FileTokens'],
		security: [{ bearerAuth: [] }],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					bucketName: { type: 'string', description: 'Bucket name' },
					filePath: { type: 'string', description: 'File path within the bucket' },
				},
				required: ['bucketName', 'filePath'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Token list',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								tokens: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											id: { type: 'string', description: 'Token ID (EAID-X)' },
											expiresAt: { type: 'number', nullable: true, description: 'Expiry timestamp in ms. null means no expiry.' },
											createdAt: { type: 'number', description: 'Creation timestamp in ms (derived from EAID-X ID)' },
										},
										required: ['id', 'expiresAt', 'createdAt'],
									} as const satisfies Schema,
								},
							},
							required: ['tokens'],
						} as const satisfies Schema,
					},
				},
			},
			400: { description: 'Bad request (missing fields)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden (not owner or admin)' },
			404: { description: 'Bucket or file not found' },
		},
	},
	{
		path: '/api/file-tokens/delete',
		method: 'post',
		summary: 'Delete a file access token',
		description: 'Revokes an access token. Requires authentication as the bucket owner or admin.',
		tags: ['FileTokens'],
		security: [{ bearerAuth: [] }],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					tokenId: { type: 'string', description: 'Token ID to delete' },
				},
				required: ['tokenId'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Deleted',
				content: {
					'application/json': {
						schema: { ref: 'OkResponse' },
					},
				},
			},
			400: { description: 'Bad request (missing tokenId)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden (not owner or admin)' },
			404: { description: 'Token not found' },
		},
	},
	{
		path: '/api/file-tokens/create-by-passphrase',
		method: 'post',
		summary: 'Create a file access token by passphrase',
		description: 'Issues an access token for a private file using a passphrase. No authentication required. If Turnstile is enabled, a turnstileToken is required.',
		tags: ['FileTokens'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					bucketName: { type: 'string', description: 'Bucket name' },
					filePath: { type: 'string', description: 'File path within the bucket' },
					passphrase: { type: 'string', description: 'Passphrase for the file' },
					turnstileToken: { type: 'string', description: 'Cloudflare Turnstile token (required when Turnstile is enabled)' },
				},
				required: ['bucketName', 'filePath', 'passphrase'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Token created',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								id: { type: 'string', description: 'Token ID (EAID-X)' },
								token: { type: 'string', description: 'Token value to use as ?token= query parameter' },
								expiresAt: { type: 'number', nullable: true, description: 'Expiry timestamp in ms' },
							},
							required: ['id', 'token', 'expiresAt'],
						} as const satisfies Schema,
					},
				},
			},
			400: { description: 'Bad request (missing fields, Turnstile verification failed, file not closed, or file is public)' },
			403: { description: 'Forbidden (no passphrase set or invalid passphrase)' },
			404: { description: 'Bucket or file not found' },
		},
	},
] as const;
