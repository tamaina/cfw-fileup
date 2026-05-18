import type * as v from 'valibot';
import { authApiDef } from './auth.js';
import { accountApiDef } from './account.js';
import { bucketsApiDef } from './buckets.js';
import { filesApiDef } from './files.js';
import { fileTokensApiDef } from './file-tokens.js';
import { adminApiDef } from './admin.js';
import { directoriesApiDef } from './directories.js';

export * from './auth.js';
export * from './account.js';
export * from './buckets.js';
export * from './files.js';
export * from './file-tokens.js';
export * from './admin.js';
export * from './directories.js';

export const apiDef = {
	...authApiDef,
	...accountApiDef,
	...bucketsApiDef,
	...filesApiDef,
	...fileTokensApiDef,
	...adminApiDef,
	...directoriesApiDef,
};

export type ApiDef = typeof apiDef;

export type ApiReq<T extends keyof ApiDef> = v.InferOutput<ApiDef[T]['req']>;

type GetSuccessSchema<Res> =
	Res extends { 200: { content: { 'application/json': { vSchema: infer S } } } }
		? S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
			? S
			: never
		: never;

export type ApiRes<T extends keyof ApiDef> = v.InferOutput<GetSuccessSchema<ApiDef[T]['res']>>;
