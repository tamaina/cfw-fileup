/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const UpdateAccountBody = v.object({
	username: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
	newPassword: v.optional(v.pipe(v.string(), v.minLength(8))),
	currentPassword: v.string(),
});
export type UpdateAccountBody = v.InferOutput<typeof UpdateAccountBody>;
