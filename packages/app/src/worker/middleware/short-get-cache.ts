import { createMiddleware } from 'hono/factory';
import { openWorkerCache, workerCacheBaseNames } from '../utils/cache-names';

type ShortGetCacheOptions = {
	maxAgeSeconds: number;
};

function isExpired(response: Response): boolean {
	const expires = response.headers.get('Expires');
	if (expires === null) return false;

	const expiresAt = Date.parse(expires);
	return !Number.isNaN(expiresAt) && expiresAt <= Date.now();
}

async function matchShortGetCache(env: Env, request: Request): Promise<Response | null> {
	const cache = await openWorkerCache(env, workerCacheBaseNames.shortGet);
	const cached = await cache.match(request);
	if (cached === undefined) return null;

	if (isExpired(cached)) {
		await cache.delete(request);
		return null;
	}

	return cached;
}

function putShortGetCache(
	env: Env,
	request: Request,
	response: Response,
	waitUntil: (promise: Promise<void>) => void,
): void {
	const cacheResponse = response.clone();
	const putPromise = (async () => {
		const cache = await openWorkerCache(env, workerCacheBaseNames.shortGet);
		await cache.put(request, cacheResponse);
	})();

	try {
		waitUntil(putPromise);
	} catch {
		void putPromise.catch((error: unknown) => {
			console.error('Failed to put GET response into cache:', error);
		});
	}
}

export function shortGetCache(options: ShortGetCacheOptions) {
	return createMiddleware<{ Bindings: Env }>(async (c, next) => {
		if (c.req.method !== 'GET') {
			await next();
			return;
		}

		const cached = await matchShortGetCache(c.env, c.req.raw);
		if (cached !== null) {
			const headers = new Headers(cached.headers);
			headers.set('X-Cache', 'HIT');
			c.res = new Response(cached.body, {
				status: cached.status,
				statusText: cached.statusText,
				headers,
			});
			return;
		}

		await next();

		if (c.res.status !== 200 || c.res.headers.has('Set-Cookie')) return;

		const headers = new Headers(c.res.headers);
		headers.set('Cache-Control', `public, max-age=${options.maxAgeSeconds}`);
		headers.set('Expires', new Date(Date.now() + options.maxAgeSeconds * 1000).toUTCString());
		headers.set('X-Cache', 'MISS');

		c.res = new Response(c.res.body, {
			status: c.res.status,
			statusText: c.res.statusText,
			headers,
		});

		putShortGetCache(c.env, c.req.raw, c.res, (promise) => c.executionCtx.waitUntil(promise));
	});
}

export async function deleteShortGetCache(env: Env, request: Request): Promise<boolean> {
	const cache = await openWorkerCache(env, workerCacheBaseNames.shortGet);
	return cache.delete(request);
}
