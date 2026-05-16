export const fileTokensApiSchema = [
	{
		path: '/api/file-tokens/create',
		method: 'post',
		summary: 'Create a file access token',
		tags: ['FileTokens'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					bucketName: { type: 'string' },
					filePath: { type: 'string' },
					expiresIn: { type: 'number', description: 'Seconds until expiry' },
				},
				required: ['bucketName', 'filePath', 'expiresIn'],
			},
		},
		responses: {
			200: {
				description: 'Token created',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								id: { type: 'string' },
								token: { type: 'string' },
								expiresAt: { type: 'number' },
							},
							required: ['id', 'token', 'expiresAt'],
						},
					},
				},
			},
		},
	},
	{
		path: '/api/file-tokens/list',
		method: 'post',
		summary: 'List file access tokens',
		tags: ['FileTokens'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					bucketName: { type: 'string' },
					filePath: { type: 'string' },
				},
				required: ['bucketName', 'filePath'],
			},
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
											id: { type: 'string' },
											expiresAt: { type: 'number' },
											createdAt: { type: 'number' },
										},
										required: ['id', 'expiresAt', 'createdAt'],
									},
								},
							},
							required: ['tokens'],
						},
					},
				},
			},
		},
	},
	{
		path: '/api/file-tokens/delete',
		method: 'post',
		summary: 'Delete a file access token',
		tags: ['FileTokens'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					tokenId: { type: 'string' },
				},
				required: ['tokenId'],
			},
		},
		responses: {
			200: {
				description: 'Deleted',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								ok: { type: 'boolean' },
							},
							required: ['ok'],
						},
					},
				},
			},
		},
	},
] as const;
