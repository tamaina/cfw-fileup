/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const authApiDef = {
	'/api/signup': {
		req: v.object({
			username: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
			password: v.pipe(v.string(), v.minLength(8)),
			passphrase: v.optional(v.string()),
			turnstileToken: v.optional(v.string()),
		}),
		res: v.object({
			userId: v.string(),
			token: v.string(),
		}),
	},
	'/api/signin': {
		req: v.object({
			username: v.string(),
			password: v.string(),
			turnstileToken: v.optional(v.string()),
		}),
		res: v.object({
			token: v.string(),
		}),
	},
};
