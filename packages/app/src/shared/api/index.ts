import * as v from 'valibot';
import { errorResponse } from '../api.schemas.js';
import { authApiDef } from './auth.js';
import { accountApiDef } from './account.js';
import { bucketsApiDef } from './buckets.js';
import { filesApiDef } from './files.js';
import { fileTokensApiDef } from './file-tokens.js';
import { fileReportsApiDef } from './file-reports.js';
import { adminApiDef } from './admin.js';
import { directoriesApiDef } from './directories.js';
import { passkeyApiDef } from './passkey.js';
import type { Context } from 'hono';
import type { ApiEndpointResponseType } from '../api.types.js';

export * from './auth.js';
export * from './account.js';
export * from './buckets.js';
export * from './files.js';
export * from './file-tokens.js';
export * from './file-reports.js';
export * from './admin.js';
export * from './directories.js';
export * from './passkey.js';

export const apiDef = {
	...authApiDef,
	...accountApiDef,
	...bucketsApiDef,
	...filesApiDef,
	...fileTokensApiDef,
	...fileReportsApiDef,
	...adminApiDef,
	...directoriesApiDef,
	...passkeyApiDef,
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

export type JsonCtx<T extends keyof ApiDef, B extends object = object> = Context<
	{ Bindings: B },
	string,
	{ in: { json: ApiReq<T> }; out: { json: ApiReq<T> } }
>;

const authErrorResponses = {
	401: errorResponse('Unauthorized', ['UNAUTHORIZED']),
	403: errorResponse('Forbidden', ['FORBIDDEN', 'ACCOUNT_IS_SUSPENDED']),
} as const satisfies ApiEndpointResponseType;

export function getResponseDefWithAuth<T extends keyof ApiDef>(
	endpoint: T,
): Omit<typeof authErrorResponses, keyof ApiDef[T]['res']> & ApiDef[T]['res'] {
	return Object.assign({}, authErrorResponses, apiDef[endpoint].res) as Omit<
    typeof authErrorResponses,
    keyof ApiDef[T]['res']
	> &
    ApiDef[T]['res'];
}
