import { createMiddleware } from 'hono/factory';

type PublicCacheControlOptions = {
	externalMaxAgeSeconds?: number;
	staleWhileRevalidateSeconds?: number;
};

/**
 * 公開ページの 200 GET レスポンスにブラウザー・CDN 向けの Cache-Control ヘッダーを付けるミドルウェア。
 * サーバー側のキャッシュ（保存・照合・パージ）は行わない。
 * バリアント（Accept等）はルート側でVaryヘッダーを設定すること。
 */
export function publicCacheControl(options: PublicCacheControlOptions = {}) {
	return createMiddleware<{ Bindings: Env }>(async (c, next) => {
		if (c.req.method !== 'GET') {
			await next();
			return;
		}

		await next();

		if (c.res.status !== 200 || c.res.headers.has('Set-Cookie')) return;

		const headers = new Headers(c.res.headers);
		if (options.externalMaxAgeSeconds !== undefined) {
			const directives = ['public', `max-age=${options.externalMaxAgeSeconds}`];
			if (options.staleWhileRevalidateSeconds !== undefined) {
				directives.push(`stale-while-revalidate=${options.staleWhileRevalidateSeconds}`);
			}
			headers.set('Cache-Control', directives.join(', '));
		}

		c.res = new Response(c.res.body, {
			status: c.res.status,
			statusText: c.res.statusText,
			headers,
		});
	});
}
