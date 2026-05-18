import type { Schema } from './schema-type';

export const indieAuthApiSchema = [
	{
		path: '/api/auth/indieauth/begin',
		method: 'get',
		summary: 'Begin IndieAuth flow (redirect to authorization endpoint)',
		tags: ['Auth'],
		parameters: [
			{
				name: 'profile_url',
				in: 'query',
				required: true,
				schema: { type: 'string' },
				description: 'Misskey profile URL (e.g. https://misskey.io/@username)',
			},
		],
		responses: {
			302: { description: 'Redirect to IndieAuth authorization endpoint' },
			400: { description: 'Invalid profile URL or IndieAuth not supported' },
			403: { description: 'Server is blocked by admin' },
		},
	},
	{
		path: '/api/auth/indieauth/callback',
		method: 'get',
		summary: 'IndieAuth callback handler',
		tags: ['Auth'],
		responses: {
			302: { description: 'Redirect to frontend with token or error' },
			400: { description: 'Invalid state or code' },
			403: { description: 'Registration closed or server blocked' },
			502: { description: 'IndieAuth token endpoint error' },
		},
	},
	{
		path: '/api/auth/indieauth/complete',
		method: 'post',
		summary: 'Complete IndieAuth sign-in by validating the issued token',
		tags: ['Auth'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					indieauthToken: { type: 'string' },
				},
				required: ['indieauthToken'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								token: { type: 'string', description: 'Authentication token' },
							},
							required: ['token'],
						} as const satisfies Schema,
					},
				},
			},
			401: { description: 'Invalid token' },
		},
	},
] as const;
