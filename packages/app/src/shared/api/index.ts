/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as v from 'valibot';
import { authApiDef } from './auth.js';
import { accountApiDef } from './account.js';
import { bucketsApiDef } from './buckets.js';
import { filesApiDef } from './files.js';
import { fileTokensApiDef } from './file-tokens.js';
import { adminApiDef } from './admin.js';

export * from './auth.js';
export * from './account.js';
export * from './buckets.js';
export * from './files.js';
export * from './file-tokens.js';
export * from './admin.js';

export const apiDef = {
	...authApiDef,
	...accountApiDef,
	...bucketsApiDef,
	...filesApiDef,
	...fileTokensApiDef,
	...adminApiDef,
};

export type ApiDef = typeof apiDef;

export type ApiReq<T extends keyof ApiDef> = v.InferOutput<ApiDef[T]['req']>;
export type ApiRes<T extends keyof ApiDef> = v.InferOutput<ApiDef[T]['res']>;
