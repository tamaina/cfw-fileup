/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const SignupBody = v.object({
	username: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
	password: v.pipe(v.string(), v.minLength(8)),
	passphrase: v.optional(v.string()),
	turnstileToken: v.optional(v.string()),
});
export type SignupBody = v.InferOutput<typeof SignupBody>;

export const SignupResponse = v.object({
	userId: v.string(),
	token: v.string(),
});
export type SignupResponse = v.InferOutput<typeof SignupResponse>;

export const SigninBody = v.object({
	username: v.string(),
	password: v.string(),
	turnstileToken: v.optional(v.string()),
});
export type SigninBody = v.InferOutput<typeof SigninBody>;

export const SigninResponse = v.object({
	token: v.string(),
});
export type SigninResponse = v.InferOutput<typeof SigninResponse>;
