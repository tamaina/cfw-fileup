import { createMiddleware } from 'hono/factory';
import { cache } from 'cloudflare:workers';

type ResolveRouteCacheOptions = {
	externalMaxAgeSeconds?: number;
	staleWhileRevalidateSeconds?: number;
};

/**
 * Workers Cache（フロントキャッシュ）用のCache-Controlヘッダーを付与するミドルウェア。
 * キャッシュの保存・照合はプラットフォーム側が自動で行う。
 * バリアント（Accept等）はルート側でVaryヘッダーを設定すること。
 */
export function resolveRouteCache(options: ResolveRouteCacheOptions = {}) {
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

/**
 * Workers CacheのフロントキャッシュをpathPrefixでパージする。
 * pathPrefixes はURLのパス部分（例: "/v/bucket/file.txt"）。
 */
export async function purgeWorkersCacheByPathPrefixes(pathPrefixes: string[]): Promise<void> {
	if (pathPrefixes.length === 0) return;

	const result = await cache.purge({ pathPrefixes });
	if (!result.success) {
		throw new Error(`Workers Cache purge failed: ${JSON.stringify(result.errors)}`);
	}
}
