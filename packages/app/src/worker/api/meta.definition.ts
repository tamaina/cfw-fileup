import type { Schema } from './schema-type';

export const metaApiSchema = [
	{
		path: '/api/meta',
		method: 'get',
		summary: 'Get server metadata',
		tags: ['Meta'],
		responses: {
			200: {
				description: 'Success',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								registrationEnabled: { type: 'boolean', description: 'Whether new user registration is enabled' },
								passphraseRequired: { type: 'boolean', description: 'Whether signup passphrase is required' },
								turnstileEnabled: { type: 'boolean', description: 'Whether Turnstile bot protection is enabled' },
								turnstileSiteKey: { type: 'string', description: 'Turnstile site key for client-side widget' },
								googleAuthEnabled: { type: 'boolean', description: 'Whether Google OAuth sign-in is enabled' },
								googleRequired: { type: 'boolean', description: 'Whether Google account is required for registration/sign-in' },
							},
							required: ['registrationEnabled', 'passphraseRequired', 'turnstileEnabled', 'turnstileSiteKey', 'googleAuthEnabled', 'googleRequired'],
						} as const satisfies Schema,
					},
				},
			},
		},
	},
] as const;
