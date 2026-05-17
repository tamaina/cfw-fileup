import type { Schema } from './schema-type';

export const passkeyApiSchema = [
	// Register begin
	{
		path: '/api/passkey/register/begin',
		method: 'post',
		summary: 'Begin passkey registration',
		tags: ['Passkey'],
		responses: {
			200: {
				description: 'Registration options',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {},
							description: 'PublicKeyCredentialCreationOptionsJSON from SimpleWebAuthn',
						} as const satisfies Schema,
					},
				},
			},
			401: { description: 'Unauthorized' },
		},
	},
	// Register finish
	{
		path: '/api/passkey/register/finish',
		method: 'post',
		summary: 'Finish passkey registration',
		tags: ['Passkey'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					challengeId: { type: 'string' },
					credential: { type: 'any' },
				},
				required: ['challengeId', 'credential'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Registration successful',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								ok: { type: 'boolean' },
							},
							required: ['ok'],
						} as const satisfies Schema,
					},
				},
			},
			400: { description: 'Bad request' },
			401: { description: 'Unauthorized' },
		},
	},
	// Authenticate begin
	{
		path: '/api/passkey/authenticate/begin',
		method: 'post',
		summary: 'Begin passkey authentication',
		tags: ['Passkey'],
		responses: {
			200: {
				description: 'Authentication options',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {},
							description: 'PublicKeyCredentialRequestOptionsJSON from SimpleWebAuthn',
						} as const satisfies Schema,
					},
				},
			},
		},
	},
	// Authenticate finish
	{
		path: '/api/passkey/authenticate/finish',
		method: 'post',
		summary: 'Finish passkey authentication',
		tags: ['Passkey'],
		requestBody: {
			'application/json': {
				type: 'object',
				properties: {
					challengeId: { type: 'string' },
					credential: { type: 'any' },
				},
				required: ['challengeId', 'credential'],
			} as const satisfies Schema,
		},
		responses: {
			200: {
				description: 'Authentication successful',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								token: { type: 'string' },
							},
							required: ['token'],
						} as const satisfies Schema,
					},
				},
			},
			400: { description: 'Bad request or invalid credential' },
			401: { description: 'Authentication failed' },
		},
	},
	// List passkeys
	{
		path: '/api/passkey/list',
		method: 'get',
		summary: 'List registered passkeys',
		tags: ['Passkey'],
		responses: {
			200: {
				description: 'Passkey list',
				content: {
					'application/json': {
						schema: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string' },
									credentialId: { type: 'string' },
									createdAt: { type: 'integer' },
								},
								required: ['id', 'credentialId', 'createdAt'],
							},
						} as const satisfies Schema,
					},
				},
			},
			401: { description: 'Unauthorized' },
		},
	},
	// Delete passkey
	{
		path: '/api/passkey/:passkeyId',
		method: 'delete',
		summary: 'Delete a passkey',
		tags: ['Passkey'],
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
						} as const satisfies Schema,
					},
				},
			},
			401: { description: 'Unauthorized' },
			404: { description: 'Not found' },
		},
	},
] as const;
