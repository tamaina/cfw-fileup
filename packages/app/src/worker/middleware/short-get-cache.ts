import { createMiddleware } from 'hono/factory';
import { getWorkerCacheVersion } from '../utils/cache-names';
import { runContextBackgroundTask } from '../utils/background-task';
import { createInternalCacheRequest, matchShortCache, putShortCache } from '../utils/short-cache';

type ShortGetCacheOptions = {
	/** Cache API の名前（ルートごとに分ける） */
	cacheName: string;
	/** サーバー（Cache API）側で持つ秒数 */
	serverMaxAgeSeconds: number;
	/** ブラウザーに返す Cache-Control の max-age */
	browserMaxAgeSeconds: number;
};

/**
 * 誰が見ても同じ内容になる公開 GET を、Cache API で短時間キャッシュするミドルウェア。
 * キーはリクエスト URL 全体（クエリ文字列込み）と全体のキャッシュバージョン。
 * ユーザーごとに内容が変わる API には使わないこと。
 */
export function shortGetCache(options: ShortGetCacheOptions) {
	return createMiddleware<{ Bindings: Env }>(async (c, next) => {
		if (c.req.method !== 'GET') {
			await next();
			return;
		}

		const cacheRequest = createInternalCacheRequest(`/${options.cacheName}`, {
			k: '1',
			v: await getWorkerCacheVersion(c.env),
			url: c.req.url,
		});
		const cached = await matchShortCache(options.cacheName, cacheRequest);
		if (cached) {
			c.res = withBrowserCacheHeaders(cached, options.browserMaxAgeSeconds);
			return;
		}

		await next();

		if (c.res.status !== 200 || c.res.headers.has('Set-Cookie')) return;

		c.res = withBrowserCacheHeaders(c.res, options.browserMaxAgeSeconds);
		runContextBackgroundTask(
			c,
			putShortCache(options.cacheName, cacheRequest, c.res.clone(), options.serverMaxAgeSeconds),
			`Failed to put ${options.cacheName} response into cache:`,
		);
	});
}

function withBrowserCacheHeaders(response: Response, maxAgeSeconds: number): Response {
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', `public, max-age=${maxAgeSeconds}`);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
