import type { Schema } from './schema-type';

export const googleAuthApiSchema = [
	{
		path: '/api/auth/google',
		method: 'get',
		summary: 'Redirect to Google OAuth2 authorization page',
		tags: ['Auth'],
		responses: {
			302: { description: 'Redirect to Google OAuth' },
			503: { description: 'Google OAuth not configured' },
		},
	},
	{
		path: '/api/auth/google/callback',
		method: 'get',
		summary: 'Google OAuth2 callback handler',
		tags: ['Auth'],
		responses: {
			302: { description: 'Redirect to frontend with token' },
			400: { description: 'Invalid state or code' },
			403: { description: 'Registration closed' },
			502: { description: 'Google API error' },
		},
	},
	{
		path: '/api/auth/google/complete',
		method: 'post',
		summary: 'Complete Google sign-in by validating the issued token',
		tags: ['Auth'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					googleToken: { type: 'string' },
				},
				required: ['googleToken'],
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
