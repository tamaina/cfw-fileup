import type { Schema } from './schema-type';

// Request schemas
export const signupSchema = {
	type: 'object',
	properties: {
		username: { type: 'string', minLength: 1, maxLength: 32 },
		password: { type: 'string', minLength: 8 },
		passphrase: { type: 'string', optional: true },
	},
	required: ['username', 'password'],
} as const satisfies Schema;

export const signinSchema = {
	type: 'object',
	properties: {
		username: { type: 'string' },
		password: { type: 'string' },
	},
	required: ['username', 'password'],
} as const satisfies Schema;

// Response schemas
export const signupResponseSchema = {
	type: 'object',
	properties: {
		userId: { type: 'string', description: 'User ID (EAID-X format)' },
		token: { type: 'string', description: 'Authentication token' },
	},
	required: ['userId', 'token'],
} as const satisfies Schema;

export const signinResponseSchema = {
	type: 'object',
	properties: {
		token: { type: 'string', description: 'Authentication token' },
	},
	required: ['token'],
} as const satisfies Schema;

export const userProfileSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'User ID' },
		username: { type: 'string', description: 'Username' },
		isAdmin: { type: 'boolean', description: 'Admin status' },
		isSuspended: { type: 'boolean', description: 'Suspension status' },
	},
	required: ['id', 'username', 'isAdmin', 'isSuspended'],
} as const satisfies Schema;

// API endpoint definitions
export const authDefinition = {
	signup: {
		request: signupSchema,
		response: signupResponseSchema,
	},
	signin: {
		request: signinSchema,
		response: signinResponseSchema,
	},
	profile: {
		response: userProfileSchema,
	},
} as const;
