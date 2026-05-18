/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const accountApiDef = {
	'/api/account/me': {
		req: v.object({}),
		res: v.object({
			id: v.string(),
			username: v.string(),
			isAdmin: v.boolean(),
		}),
	},
	'/api/account/update': {
		req: v.object({
			username: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
			newPassword: v.optional(v.pipe(v.string(), v.minLength(8))),
			currentPassword: v.string(),
		}),
		res: v.object({ ok: v.literal(true) }),
	},
};
