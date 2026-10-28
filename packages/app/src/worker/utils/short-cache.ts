/**
 * Cache API に小さな JSON やレスポンスを短時間だけ置くためのヘルパー。
 *
 * - Cache API はデータセンター（colo）ごとのキャッシュで、`cache.delete` は実行した colo のものしか消せない。
 *   そのため明示的な削除は「同じ colo ですぐ反映させる」ためのもので、他の colo では TTL が切れるまで古い値が残る。
 * - 有効期限は Cache-Control の max-age に加えて、app-settings-cache と同じく独自ヘッダーでもコード側で確認する。
 */

/** 超短期キャッシュの標準 TTL（秒）。 */
export const shortCacheTtlSeconds = 30;

const internalCacheOrigin = 'https://cache.cfw-fileup.local';
const expiresHeader = 'X-Cfw-Fileup-Cache-Expires';

export function createInternalCacheRequest(path: string, params: Record<string, string>): Request {
	const url = new URL(path, internalCacheOrigin);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return new Request(url, { method: 'GET' });
}

function isExpired(response: Response): boolean {
	const expires = response.headers.get(expiresHeader);
	if (expires === null) return false;

	const expiresAt = Number(expires);
	return !Number.isNaN(expiresAt) && expiresAt <= Date.now();
}

/** 期限切れなら削除して undefined を返す。Cache API が使えない場合も undefined。返すレスポンスに内部用の期限ヘッダーは含まない。 */
export async function matchShortCache(cacheName: string, request: Request): Promise<Response | undefined> {
	try {
		const cache = await caches.open(cacheName);
		const response = await cache.match(request);
		if (!response) return undefined;
		if (isExpired(response)) {
			await response.body?.cancel();
			await cache.delete(request);
			return undefined;
		}
		// 内部用の期限ヘッダーはクライアントに出さない
		const headers = new Headers(response.headers);
		headers.delete(expiresHeader);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch (error) {
		console.error(`Failed to read ${cacheName} cache:`, error);
		return undefined;
	}
}

/** `response` のヘッダーを上書きして TTL 付きで保存する（Cache-Control は内部用の値になる）。 */
export async function putShortCache(cacheName: string, request: Request, response: Response, ttlSeconds: number): Promise<void> {
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
	headers.delete('Expires');
	headers.set(expiresHeader, String(Date.now() + ttlSeconds * 1000));
	const cache = await caches.open(cacheName);
	await cache.put(request, new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	}));
}

export async function matchShortCacheJson<T>(cacheName: string, request: Request): Promise<{ value: T } | undefined> {
	const response = await matchShortCache(cacheName, request);
	if (!response) return undefined;
	try {
		return { value: await response.json() as T };
	} catch {
		return undefined;
	}
}

export async function putShortCacheJson(cacheName: string, request: Request, value: unknown, ttlSeconds: number): Promise<void> {
	await putShortCache(cacheName, request, new Response(JSON.stringify(value), {
		headers: { 'Content-Type': 'application/json' },
	}), ttlSeconds);
}

/** この colo のエントリーだけを消す。 */
export async function deleteShortCache(cacheName: string, request: Request): Promise<void> {
	try {
		const cache = await caches.open(cacheName);
		await cache.delete(request);
	} catch (error) {
		console.error(`Failed to delete ${cacheName} cache:`, error);
	}
}
