import { authHeaders } from '../store/auth';

/**
 * Wrapper for standard POST JSON API calls.
 * Automatically adds Authorization and Content-Type headers.
 */
export async function apiPost<T>(endpoint: string, body: unknown = {}): Promise<{ res: Response; data: T }> {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify(body),
	});
	const data = (await res.json()) as T;
	return { res, data };
}
