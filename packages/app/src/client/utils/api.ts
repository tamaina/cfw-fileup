import type * as v from 'valibot';
import { authHeaders } from '../store/auth';
import type { ApiDef } from '../../shared/api';

export async function apiPost<E extends keyof ApiDef>(
	endpoint: E,
	body: v.InferOutput<ApiDef[E]['req']>,
): Promise<{ res: Response; data: v.InferOutput<ApiDef[E]['res']> }>;
export async function apiPost<T = unknown>(
	endpoint: string,
	body?: unknown,
): Promise<{ res: Response; data: T }>;
export async function apiPost(endpoint: string, body: unknown = {}): Promise<{ res: Response; data: unknown }> {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify(body),
	});
	const data = (await res.json()) as unknown;
	return { res, data };
}
