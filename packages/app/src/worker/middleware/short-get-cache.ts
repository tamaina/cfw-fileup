import { createMiddleware } from 'hono/factory';

type ShortGetCacheOptions = {
	maxAgeSeconds: number;
};

/**
 * Workers Cache（フロントキャッシュ）用のCache-Controlヘッダーを付与するミドルウェア。
 * キャッシュの保存・照合はプラットフォーム側が自動で行う。
 */
export function shortGetCache(options: ShortGetCacheOptions) {
	return createMiddleware<{ Bindings: Env }>(async (c, next) => {
		if (c.req.method !== 'GET') {
			await next();
			return;
		}

		await next();

		if (c.res.status !== 200 || c.res.headers.has('Set-Cookie')) return;

		const headers = new Headers(c.res.headers);
		headers.set('Cache-Control', `public, max-age=${options.maxAgeSeconds}`);

		c.res = new Response(c.res.body, {
			status: c.res.status,
			statusText: c.res.statusText,
			headers,
		});
	});
}
