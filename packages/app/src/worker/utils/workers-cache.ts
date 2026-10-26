/**
 * Workers Cache（wrangler の `"cache": { "enabled": true }`）だけに効く Cache-Control。
 * Cloudflare が読み取ってからクライアントへのレスポンスでは取り除くので、ブラウザ向けの Cache-Control には影響しない。
 */
export const workersCacheControlHeader = 'Cloudflare-CDN-Cache-Control';

/**
 * レスポンスを Workers Cache に保存させない。
 * レスポンスですでに Workers Cache 用の指定をしている場合はそれを優先する。
 */
export function withWorkersCacheNoStore(response: Response): Response {
	if (response.headers.has(workersCacheControlHeader)) return response;
	try {
		response.headers.set(workersCacheControlHeader, 'no-store');
		return response;
	} catch {
		// ヘッダーが変更できないレスポンス（fetch の結果など）は作り直す
		const headers = new Headers(response.headers);
		headers.set(workersCacheControlHeader, 'no-store');
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	}
}
