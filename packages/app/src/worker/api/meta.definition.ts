import type { Schema } from './schema-type';

// Response schemas
export const metaResponseSchema = {
	type: 'object',
	properties: {
		registrationEnabled: { type: 'boolean' as const, description: 'Whether new user registration is enabled' },
		passphraseRequired: { type: 'boolean' as const, description: 'Whether signup passphrase is required' },
	},
	required: ['registrationEnabled', 'passphraseRequired'],
} as const satisfies Schema;

// API endpoint definitions
export const metaDefinition = {
	getMeta: {
		response: metaResponseSchema,
	},
} as const;
