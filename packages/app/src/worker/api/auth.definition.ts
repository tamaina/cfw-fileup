import type { Schema } from './schema-type';

const signupSchema = {
	type: 'object',
	properties: {
		username: { type: 'string', minLength: 1, maxLength: 32 },
		password: { type: 'string', minLength: 8 },
		passphrase: { type: 'string', optional: true },
	},
	required: ['username', 'password'],
} as const satisfies Schema;

const signinSchema = {
	type: 'object',
	properties: {
		username: { type: 'string' },
		password: { type: 'string' },
	},
	required: ['username', 'password'],
} as const satisfies Schema;

const signupResponseSchema = {
	type: 'object',
	properties: {
		userId: { type: 'string', description: 'User ID (EAID-X format)' },
		token: { type: 'string', description: 'Authentication token' },
	},
	required: ['userId', 'token'],
} as const satisfies Schema;

const signinResponseSchema = {
	type: 'object',
	properties: {
		token: { type: 'string', description: 'Authentication token' },
	},
	required: ['token'],
} as const satisfies Schema;

const userProfileSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'User ID' },
		username: { type: 'string', description: 'Username' },
		isAdmin: { type: 'boolean', description: 'Admin status' },
		isSuspended: { type: 'boolean', description: 'Suspension status' },
	},
	required: ['id', 'username', 'isAdmin', 'isSuspended'],
} as const satisfies Schema;

export const authApiSchema = [
	{
		path: '/api/signup',
		method: 'post',
		summary: 'User signup',
		tags: ['Auth'],
		requestBody: {
			'application/json': signupSchema,
		},
		responses: {
			201: {
				description: 'User created',
				content: {
					'application/json': { schema: signupResponseSchema }
				}
			},
			400: { description: 'Bad request' },
			409: { description: 'User exists' },
		},
	},
	{
		path: '/api/signin',
		method: 'post',
		summary: 'User signin',
		tags: ['Auth'],
		requestBody: {
			'application/json': signinSchema,
		},
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: signinResponseSchema }
				}
			},
			401: { description: 'Invalid credentials' },
		},
	},
	{
		path: '/api/account/me',
		method: 'get',
		summary: 'Get user profile',
		tags: ['Auth'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': { schema: userProfileSchema }
				}
			},
			401: { description: 'Unauthorized' },
		},
	},
] as const;

export { signupSchema, signinSchema, signupResponseSchema, signinResponseSchema, userProfileSchema };
