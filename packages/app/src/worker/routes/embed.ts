import { Hono } from 'hono';
import { getDb } from '../utils/db';
import { apiError } from '../utils/api-error';
import { getPublicFile } from '../utils/public-file';
import { getHlsTarMetadata } from '../utils/hls-tar-metadata';
import { deleteResolveRouteCache, resolveRouteCache } from '../middleware/resolve-route-cache';
import { fileMutationEvents, runMutationTask, type FileReference } from '../events/file-mutations';
import { archiveEntryStreamUrl } from '../../shared/archive-entry-url';

const app = new Hono<{ Bindings: Env }>();

const embedCacheMaxAgeSeconds = 3 * 60 * 60;
let embedCachePurgeListenersRegistered = false;

function getEmbedCachePath(fileId: string): string {
	return `/e/${encodeURIComponent(fileId)}`;
}

function purgeEmbedCache(env: Env, origin: string, files: FileReference[]): Promise<Array<PromiseSettledResult<boolean>>> {
	return Promise.allSettled(files.map(file => deleteResolveRouteCache(env, getEmbedCachePath(file.id), origin)));
}

function registerEmbedCachePurgeListeners(): void {
	if (embedCachePurgeListenersRegistered) return;
	embedCachePurgeListenersRegistered = true;

	const events = ['file:deleted', 'file:updated', 'file:moved', 'directory:deleted', 'directory:moved', 'bucket:deleted'] as const;
	for (const event of events) {
		fileMutationEvents.on(event, ({ env, origin, waitUntil, files }) => {
			const promise = purgeEmbedCache(env, origin, files).then(() => undefined);
			runMutationTask(waitUntil, promise, `Failed to purge /e ${event} cache:`);
		});
	}
}

registerEmbedCachePurgeListeners();

app.use('/e/*', resolveRouteCache({ externalMaxAgeSeconds: embedCacheMaxAgeSeconds }));

app.get('/e/:fileId', async (c) => {
	const db = getDb(c.env);
	const { file } = await getPublicFile(db, c.req.param('fileId'));
	const metadata = await getHlsTarMetadata(c.env, db, file);
	if (!metadata) throw apiError(404, 'FILE_NOT_FOUND');

	const origin = new URL(c.req.url).origin;
	const assetResponse = await c.env.ASSETS.fetch(new Request(new URL('/embed.html', origin)));
	if (!assetResponse.ok) throw apiError(500, 'INTERNAL_SERVER_ERROR');

	const config = {
		fileId: file.id,
		masterUrl: archiveEntryStreamUrl(file.id, metadata.masterEntryPath),
		posterUrl: metadata.posterEntryPath ? archiveEntryStreamUrl(file.id, metadata.posterEntryPath) : null,
		title: metadata.title ?? (file.path.split('/').pop() ?? file.path),
	};
	const configJson = JSON.stringify(config).replaceAll('<', '\\u003c');

	return new HTMLRewriter()
		.on('script#embed-config', {
			element(element) {
				element.setInnerContent(configJson, { html: true });
			},
		})
		.transform(new Response(assetResponse.body, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		}));
});

export const embedRoutes = app;
