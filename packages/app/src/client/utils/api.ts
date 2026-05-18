import type * as v from 'valibot';
import { authHeaders } from '../store/auth';
import type { ApiDef } from '../../shared/api';

type GetSuccessSchema<Res> =
	Res extends { 200: { content: { 'application/json': { vSchema: infer S } } } }
		? S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
			? S
			: never
		: never;

export type ApiSuccess<E extends keyof ApiDef> = {
	ok: true;
	status: number;
	data: v.InferOutput<GetSuccessSchema<ApiDef[E]['res']>>;
};

export type ApiFailure = {
	ok: false;
	status: number;
	data: { error: string };
};

export type ApiResult<E extends keyof ApiDef> = ApiSuccess<E> | ApiFailure;

export async function apiPost<E extends keyof ApiDef>(
	endpoint: E,
	body?: v.InferOutput<ApiDef[E]['req']>,
	url?: string,
): Promise<ApiResult<E>> {
	const res = await fetch(url ?? endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify(body ?? {}),
	});
	const data = await res.json();
	if (res.ok) {
		return { ok: true, status: res.status, data };
	}
	return { ok: false, status: res.status, data: (data as { error?: string }).error ? (data as { error: string }) : { error: `HTTP ${res.status}` } };
}
