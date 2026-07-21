import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { parseEaidx } from '../../shared/eaid-x';
import { buckets, files, tarFiles, targzFiles } from '../scheme/index';
import { getDb } from '../utils/db';
import { apiError } from '../utils/api-error';
import { resolveRouteCache, purgeWorkersCacheByPathPrefixes } from '../middleware/resolve-route-cache';
import { fileMutationEvents, runMutationTask } from '../events/file-mutations';
import { getAppName } from '../utils/app-name';
import { getPublicFile } from '../utils/public-file';
import { getHlsTarMetadata } from '../utils/hls-tar-metadata';
import { HLS_TAR_MIME } from '../../shared/hls';
import { archiveEntryStreamUrl } from '../../shared/archive-entry-url';

const app = new Hono<{ Bindings: Env }>();
type AppContext = Context<{ Bindings: Env }>;

const activityJsonContentType = 'application/activity+json; charset=utf-8';
const publicAddress = 'https://www.w3.org/ns/activitystreams#Public';
const activityPubCacheMaxAgeSeconds = 5 * 60;
const activityPubCacheStaleWhileRevalidateSeconds = 12 * 60 * 60;
let activityPubCachePurgeListenersRegistered = false;

function originFromRequest(request: Request): string {
	return new URL(request.url).origin;
}

function activityJson(c: AppContext, value: unknown): Response {
	return c.json(value, 200, {
		'Content-Type': activityJsonContentType,
		'Vary': 'Accept',
	});
}

function redirectToFilePage(c: AppContext, url: string): Response {
	const response = c.redirect(url, 302);
	response.headers.set('Vary', 'Accept');
	return response;
}

function acceptsActivityJson(request: Request): boolean {
	const accept = request.headers.get('Accept')?.toLowerCase() ?? '';
	return accept.includes('application/activity+json') || accept.includes('application/ld+json');
}

function basename(path: string): string {
	return path.replace(/\/$/, '').split('/').pop() ?? path;
}

function encodeFilePath(path: string): string {
	return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function fileViewUrl(origin: string, bucketName: string, filePath: string, entryPath?: string): string {
	const encodedFilePath = encodeFilePath(filePath);
	return entryPath !== undefined
		? `${origin}/v/${encodeURIComponent(bucketName)}/${encodedFilePath}/${encodeURIComponent(':entries')}/${encodeURIComponent(entryPath)}`
		: `${origin}/v/${encodeURIComponent(bucketName)}/${encodedFilePath}`;
}

function absoluteUrl(origin: string, path: string): string {
	return new URL(path, origin).toString();
}

function documentTypeForMime(mimeType: string | null): 'Audio' | 'Document' | 'Image' | 'Video' {
	if (mimeType?.startsWith('image/')) return 'Image';
	if (mimeType?.startsWith('video/')) return 'Video';
	if (mimeType?.startsWith('audio/')) return 'Audio';
	return 'Document';
}

function bucketActor(origin: string, bucket: typeof buckets.$inferSelect, appName: string) {
	const id = `${origin}/a/buckets/${bucket.id}`;
	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id,
		type: 'Service',
		preferredUsername: bucket.name,
		name: `${bucket.name} @ ${appName}`,
		url: `${origin}/v/${encodeURIComponent(bucket.name)}/`,
		inbox: `${id}/inbox`,
		outbox: `${id}/outbox`,
		followers: `${id}/followers`,
		manuallyApprovesFollowers: false,
		discoverable: true,
	};
}

function emptyOrderedCollection(id: string) {
	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id,
		type: 'OrderedCollection',
		totalItems: 0,
		orderedItems: [],
	};
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll('\'', '&#39;');
}

function fileNote(options: {
	origin: string;
	bucket: typeof buckets.$inferSelect;
	file: typeof files.$inferSelect;
	entry?: { path: string; mimeType: string; size?: number | null };
	/** HLS tar のときに設定。attachment の代わりに /v/ ページへのリンクを吐く */
	hlsView?: { viewUrl: string; title: string | null; playlistUrl: string };
}) {
	const actorId = `${options.origin}/a/buckets/${options.bucket.id}`;
	const entry = options.entry;
	const encodedEntryPath = entry === undefined ? null : encodeURIComponent(entry.path);
	const objectId = entry !== undefined
		? `${options.origin}/a/files/${options.file.id}/${encodeURIComponent(':entries')}/${encodedEntryPath}`
		: `${options.origin}/a/files/${options.file.id}`;
	const downloadUrl = entry !== undefined
		? `${options.origin}/d/${options.file.id}/${encodeURIComponent(':entries')}/${encodedEntryPath}`
		: `${options.origin}/d/${options.file.id}`;
	const name = entry !== undefined ? basename(entry.path) : basename(options.file.path);
	const mimeType = entry !== undefined ? entry.mimeType : options.file.mimeType;
	const size = entry !== undefined ? entry.size : options.file.size;

	const base = {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: objectId,
		type: 'Note',
		attributedTo: actorId,
		to: [publicAddress],
		cc: [`${actorId}/followers`],
		published: parseEaidx(options.file.id).date.toISOString(),
	};

	if (options.hlsView) {
		// HLS tar は tar 自体を添付しても再生できないため、attachment は付けず
		// /v/ ページへのリンクを吐いて受信側（Misskey 等）のリンクプレビュー
		// （OGP の twitter:player → /e/ 埋め込みプレイヤー）に任せる。
		// name/url も付けると Misskey ではタイトルと URL が本文と重複して表示される。
		const title = options.hlsView.title ?? name;
		return {
			...base,
			content: `<p><a href="${escapeHtml(options.hlsView.viewUrl)}">${escapeHtml(title)}</a></p>`,
			url: [
				{
					type: 'Link',
					mediaType: 'text/html',
					href: options.hlsView.viewUrl,
				},
				{
					type: 'Link',
					mediaType: 'application/x-mpegURL',
					href: options.hlsView.playlistUrl,
				},
			],
		};
	}

	return {
		...base,
		attachment: [{
			type: documentTypeForMime(mimeType),
			name,
			mediaType: mimeType ?? 'application/octet-stream',
			url: downloadUrl,
			...(typeof size === 'number' ? { size } : {}),
		}],
	};
}

async function getBucket(db: ReturnType<typeof getDb>, bucketId: string) {
	const bucket = await db.select().from(buckets).where(eq(buckets.id, bucketId)).get();
	if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
	return bucket;
}

function getActivityPubFileCachePath(fileId: string): string {
	return `/a/files/${encodeURIComponent(fileId)}`;
}

function getActivityPubEntryCachePath(fileId: string, entryPath: string): string {
	return `${getActivityPubFileCachePath(fileId)}/${encodeURIComponent(':entries')}/${encodeURIComponent(entryPath)}`;
}

function registerActivityPubCachePurgeListeners(): void {
	if (activityPubCachePurgeListenersRegistered) return;
	activityPubCachePurgeListenersRegistered = true;

	fileMutationEvents.on('file:deleted', ({ waitUntil, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getActivityPubFileCachePath(file.id),
			...(file.entryPaths ?? []).map(entryPath => getActivityPubEntryCachePath(file.id, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /a deleted file cache:');
	});

	fileMutationEvents.on('file:updated', ({ waitUntil, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getActivityPubFileCachePath(file.id),
			...(file.entryPaths ?? []).map(entryPath => getActivityPubEntryCachePath(file.id, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /a updated file cache:');
	});

	fileMutationEvents.on('file:moved', ({ waitUntil, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getActivityPubFileCachePath(file.id),
			...(file.entryPaths ?? []).map(entryPath => getActivityPubEntryCachePath(file.id, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /a moved file cache:');
	});

	fileMutationEvents.on('directory:deleted', ({ waitUntil, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getActivityPubFileCachePath(file.id),
			...(file.entryPaths ?? []).map(entryPath => getActivityPubEntryCachePath(file.id, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /a deleted directory cache:');
	});

	fileMutationEvents.on('directory:moved', ({ waitUntil, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getActivityPubFileCachePath(file.id),
			...(file.entryPaths ?? []).map(entryPath => getActivityPubEntryCachePath(file.id, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /a moved directory cache:');
	});

	fileMutationEvents.on('bucket:deleted', ({ waitUntil, bucket, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes([
			`/a/buckets/${encodeURIComponent(bucket.id)}`,
			`/a/buckets/${encodeURIComponent(bucket.id)}/outbox`,
			`/a/buckets/${encodeURIComponent(bucket.id)}/followers`,
			...files.flatMap(file => [
				getActivityPubFileCachePath(file.id),
				...(file.entryPaths ?? []).map(entryPath => getActivityPubEntryCachePath(file.id, entryPath)),
			]),
		]);
		runMutationTask(waitUntil, promise, 'Failed to purge /a deleted bucket cache:');
	});
}

registerActivityPubCachePurgeListeners();

app.use('/a/*', resolveRouteCache({
	externalMaxAgeSeconds: activityPubCacheMaxAgeSeconds,
	staleWhileRevalidateSeconds: activityPubCacheStaleWhileRevalidateSeconds,
}));

app.get('/a/buckets/:bucketId', async (c) => {
	const db = getDb(c.env);
	const bucket = await getBucket(db, c.req.param('bucketId'));
	const appName = await getAppName(c.env);
	return activityJson(c, bucketActor(originFromRequest(c.req.raw), bucket, appName));
});

app.get('/a/buckets/:bucketId/outbox', async (c) => {
	const db = getDb(c.env);
	await getBucket(db, c.req.param('bucketId'));
	return activityJson(c, emptyOrderedCollection(`${originFromRequest(c.req.raw)}/a/buckets/${c.req.param('bucketId')}/outbox`));
});

app.get('/a/buckets/:bucketId/followers', async (c) => {
	const db = getDb(c.env);
	await getBucket(db, c.req.param('bucketId'));
	return activityJson(c, emptyOrderedCollection(`${originFromRequest(c.req.raw)}/a/buckets/${c.req.param('bucketId')}/followers`));
});

app.post('/a/buckets/:bucketId/inbox', async (c) => {
	const db = getDb(c.env);
	await getBucket(db, c.req.param('bucketId'));
	return c.body(null, 202);
});

app.get('/a/files/:fileId/:entryMarker/:entryPath{.+}', async (c) => {
	if (c.req.param('entryMarker') !== ':entries') throw apiError(404, 'FILE_NOT_FOUND');
	const db = getDb(c.env);
	const { file, bucket } = await getPublicFile(db, c.req.param('fileId'));
	const entryPath = c.req.param('entryPath');
	if (!acceptsActivityJson(c.req.raw)) {
		return redirectToFilePage(c, fileViewUrl(originFromRequest(c.req.raw), bucket.name, file.path, entryPath));
	}
	const entry = file.isTar
		? await db.select().from(tarFiles).where(and(eq(tarFiles.fileId, file.id), eq(tarFiles.path, entryPath))).get()
		: file.isTargz
			? await db.select().from(targzFiles).where(and(eq(targzFiles.fileId, file.id), eq(targzFiles.path, entryPath))).get()
			: undefined;
	if (!entry) throw apiError(404, 'FILE_NOT_FOUND_IN_ARCHIVE');
	return activityJson(c, fileNote({
		origin: originFromRequest(c.req.raw),
		bucket,
		file,
		entry: { path: entry.path, mimeType: entry.mimeType, size: 'size' in entry ? entry.size : null },
	}));
});

app.get('/a/files/:fileId', async (c) => {
	const db = getDb(c.env);
	const { file, bucket } = await getPublicFile(db, c.req.param('fileId'));
	if (!acceptsActivityJson(c.req.raw)) {
		return redirectToFilePage(c, fileViewUrl(originFromRequest(c.req.raw), bucket.name, file.path));
	}
	const origin = originFromRequest(c.req.raw);
	const hlsMetadata = file.mimeType === HLS_TAR_MIME ? await getHlsTarMetadata(c.env, db, file) : null;
	return activityJson(c, fileNote({
		origin,
		bucket,
		file,
		hlsView: hlsMetadata
			? {
				viewUrl: fileViewUrl(origin, bucket.name, file.path),
				title: hlsMetadata.title,
				playlistUrl: absoluteUrl(origin, archiveEntryStreamUrl(file.id, hlsMetadata.masterEntryPath)),
			}
			: undefined,
	}));
});

export const activityPubRoutes = app;
