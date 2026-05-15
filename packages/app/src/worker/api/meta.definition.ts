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
							},
							required: ['registrationEnabled', 'passphraseRequired'],
						} as const satisfies Schema
					}
				}
			},
		},
	},
] as const;
