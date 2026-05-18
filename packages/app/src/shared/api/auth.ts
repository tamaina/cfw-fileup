import * as v from 'valibot';

export const authApiDef = {
	'/api/signup': {
		req: v.object({
			username: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
			password: v.pipe(v.string(), v.minLength(8)),
			passphrase: v.optional(v.string()),
			turnstileToken: v.optional(v.string()),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ userId: v.string(), token: v.string() }) } } },
			400: { description: 'Bad request (missing fields, invalid username/password, or Turnstile failure)' },
			403: { description: 'Forbidden (invalid passphrase or registration closed)' },
			409: { description: 'Username already exists' },
		},
	},
	'/api/signin': {
		req: v.object({
			username: v.string(),
			password: v.string(),
			turnstileToken: v.optional(v.string()),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ token: v.string() }) } } },
			400: { description: 'Bad request (missing fields or Turnstile failure)' },
			401: { description: 'Invalid credentials or account suspended' },
		},
	},
};
