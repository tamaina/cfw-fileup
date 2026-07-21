import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { buckets, files, tarFiles, targzFiles } from '../scheme/index';
import { resolveRouteCache, purgeWorkersCacheByPathPrefixes } from '../middleware/resolve-route-cache';
import { getDb } from '../utils/db';
import { fileMutationEvents, runMutationTask, type FileReference } from '../events/file-mutations';
import { getAppName } from '../utils/app-name';
import { getHlsTarMetadata } from '../utils/hls-tar-metadata';
import { HLS_TAR_MIME } from '../../shared/hls';
import { archiveEntryStreamUrl } from '../../shared/archive-entry-url';

const app = new Hono<{ Bindings: Env }>();
type AppContext = Context<{ Bindings: Env }>;

const activityJsonType = 'application/activity+json';
const viewHtmlCacheMaxAgeSeconds = 3 * 60 * 60;
let viewHtmlCachePurgeListenersRegistered = false;

function decodePathSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

function parseViewPath(url: string): { bucketName: string; filePath: string; entryPath: string | null } | null {
	const pathname = new URL(url).pathname;
	const segments = pathname.split('/').filter(Boolean);
	if (segments[0] !== 'v' || segments.length < 3) return null;

	const bucketName = decodePathSegment(segments[1]);
	if (bucketName === null) return null;

	const entryMarkerIndex = segments.findIndex((segment, index) => index >= 2 && decodePathSegment(segment) === ':entries');
	if (entryMarkerIndex === -1) {
		const filePathSegments = segments.slice(2).map(decodePathSegment);
		if (filePathSegments.some(segment => segment === null)) return null;
		return { bucketName, filePath: filePathSegments.join('/'), entryPath: null };
	}

	if (entryMarkerIndex === 2 || entryMarkerIndex + 1 >= segments.length) return null;
	const filePathSegments = segments.slice(2, entryMarkerIndex).map(decodePathSegment);
	if (filePathSegments.some(segment => segment === null)) return null;
	const entryPath = decodePathSegment(segments[entryMarkerIndex + 1]);
	if (entryPath === null) return null;
	return { bucketName, filePath: filePathSegments.join('/'), entryPath };
}

interface ViewFileContext {
	href: string;
	fileId: string;
	filePath: string;
	entryPath: string | null;
	mimeType: string | null;
	isTar: boolean;
	r2Key: string;
}

async function resolveViewFileContext(c: AppContext): Promise<ViewFileContext | null> {
	const parsed = parseViewPath(c.req.url);
	if (!parsed || parsed.filePath === '' || parsed.filePath.endsWith('/')) return null;

	const db = getDb(c.env);
	const bucket = await db
		.select({ id: buckets.id })
		.from(buckets)
		.where(eq(buckets.name, parsed.bucketName))
		.get();
	if (!bucket) return null;

	const file = await db
		.select({ id: files.id, isTar: files.isTar, isTargz: files.isTargz, mimeType: files.mimeType, r2Key: files.r2Key })
		.from(files)
		.where(and(
			eq(files.bucketId, bucket.id),
			eq(files.path, parsed.filePath),
			eq(files.isClosed, true),
			eq(files.visibility, 'public'),
			eq(files.isListed, true),
			eq(files.isModerationForcedPrivate, false),
		))
		.get();
	if (!file) return null;

	const origin = new URL(c.req.url).origin;
	const context = {
		fileId: file.id,
		filePath: parsed.filePath,
		entryPath: parsed.entryPath,
		mimeType: file.mimeType,
		isTar: file.isTar,
		r2Key: file.r2Key,
	};
	if (parsed.entryPath === null) return { ...context, href: `${origin}/a/files/${file.id}` };

	const entry = file.isTar
		? await db.select({ id: tarFiles.id }).from(tarFiles).where(and(eq(tarFiles.fileId, file.id), eq(tarFiles.path, parsed.entryPath))).get()
		: file.isTargz
			? await db.select({ id: targzFiles.id }).from(targzFiles).where(and(eq(targzFiles.fileId, file.id), eq(targzFiles.path, parsed.entryPath))).get()
			: null;
	if (!entry) return null;
	return { ...context, href: `${origin}/a/files/${file.id}/${encodeURIComponent(':entries')}/${encodeURIComponent(parsed.entryPath)}` };
}

function escapeHtmlAttr(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function metaTag(attribute: 'property' | 'name', key: string, content: string): string {
	return `<meta ${attribute}="${escapeHtmlAttr(key)}" content="${escapeHtmlAttr(content)}">`;
}

/** HLS tar の /v/ ページ向け OGP。twitter:player → /e/ で Misskey 等にプレイヤー埋め込みを出させる */
function buildHlsOgpHead(options: {
	origin: string;
	fileId: string;
	filePath: string;
	title: string | null;
	posterEntryPath: string | null;
	appName: string;
	pageUrl: string;
}): string {
	const title = options.title ?? (options.filePath.split('/').pop() ?? options.filePath);
	const embedUrl = `${options.origin}/e/${options.fileId}`;
	const tags = [
		metaTag('property', 'og:type', 'video.other'),
		metaTag('property', 'og:title', title),
		metaTag('property', 'og:url', options.pageUrl),
		metaTag('property', 'og:site_name', options.appName),
		metaTag('property', 'og:video', embedUrl),
		metaTag('property', 'og:video:secure_url', embedUrl),
		metaTag('property', 'og:video:type', 'text/html'),
		metaTag('property', 'og:video:width', '1280'),
		metaTag('property', 'og:video:height', '720'),
		metaTag('name', 'twitter:card', 'player'),
		metaTag('name', 'twitter:player', embedUrl),
		metaTag('name', 'twitter:player:width', '1280'),
		metaTag('name', 'twitter:player:height', '720'),
	];
	if (options.posterEntryPath) {
		const posterUrl = `${options.origin}${archiveEntryStreamUrl(options.fileId, options.posterEntryPath)}`;
		tags.push(metaTag('property', 'og:image', posterUrl));
		tags.push(metaTag('name', 'twitter:image', posterUrl));
	}
	return tags.join('');
}

function appendLinkHeader(headers: Headers, href: string): void {
	const link = `<${href}>; rel="alternate"; type="${activityJsonType}"`;
	const current = headers.get('Link');
	headers.set('Link', current ? `${current}, ${link}` : link);
}

function withActivityPubAlternate(response: Response, href: string, extraHeadHtml = ''): Response {
	const safeHref = href.replace(/"/g, '%22');
	const transformed = new HTMLRewriter()
		.on('head', {
			element(element) {
				element.append(`<link rel="alternate" type="${activityJsonType}" href="${safeHref}">${extraHeadHtml}`, { html: true });
			},
		})
		.transform(response);
	const headers = new Headers(transformed.headers);
	appendLinkHeader(headers, href);
	headers.delete('Content-Length');
	headers.delete('ETag');
	return new Response(transformed.body, {
		status: transformed.status,
		statusText: transformed.statusText,
		headers,
	});
}

function encodePath(path: string): string {
	return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function getViewCachePath(bucketName: string, filePath: string): string {
	return `/v/${encodeURIComponent(bucketName)}/${encodePath(filePath)}`;
}

function getArchiveEntryViewCachePath(bucketName: string, filePath: string, entryPath: string): string {
	return `${getViewCachePath(bucketName, filePath)}/${encodeURIComponent(':entries')}/${encodeURIComponent(entryPath)}`;
}

function registerViewHtmlCachePurgeListeners(): void {
	if (viewHtmlCachePurgeListenersRegistered) return;
	viewHtmlCachePurgeListenersRegistered = true;

	fileMutationEvents.on('file:deleted', ({ waitUntil, bucket, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getViewCachePath(bucket.name, file.path),
			...(file.entryPaths ?? []).map(entryPath => getArchiveEntryViewCachePath(bucket.name, file.path, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /v deleted file cache:');
	});

	fileMutationEvents.on('file:updated', ({ waitUntil, bucket, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getViewCachePath(bucket.name, file.path),
			...(file.entryPaths ?? []).map(entryPath => getArchiveEntryViewCachePath(bucket.name, file.path, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /v updated file cache:');
	});

	fileMutationEvents.on('file:moved', ({ waitUntil, sourceBucket, targetBucket, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getViewCachePath(sourceBucket.name, file.path),
			...(file.entryPaths ?? []).map(entryPath => getArchiveEntryViewCachePath(sourceBucket.name, file.path, entryPath)),
			getViewCachePath(targetBucket.name, file.nextPath),
			...(file.entryPaths ?? []).map(entryPath => getArchiveEntryViewCachePath(targetBucket.name, file.nextPath, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /v moved file cache:');
	});

	fileMutationEvents.on('directory:deleted', ({ waitUntil, bucket, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getViewCachePath(bucket.name, file.path),
			...(file.entryPaths ?? []).map(entryPath => getArchiveEntryViewCachePath(bucket.name, file.path, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /v deleted directory cache:');
	});

	fileMutationEvents.on('directory:moved', ({ waitUntil, sourceBucket, targetBucket, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getViewCachePath(sourceBucket.name, file.path),
			...(file.entryPaths ?? []).map(entryPath => getArchiveEntryViewCachePath(sourceBucket.name, file.path, entryPath)),
			getViewCachePath(targetBucket.name, file.nextPath),
			...(file.entryPaths ?? []).map(entryPath => getArchiveEntryViewCachePath(targetBucket.name, file.nextPath, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /v moved directory cache:');
	});

	fileMutationEvents.on('bucket:deleted', ({ waitUntil, bucket, files }) => {
		const promise = purgeWorkersCacheByPathPrefixes(files.flatMap(file => [
			getViewCachePath(bucket.name, file.path),
			...(file.entryPaths ?? []).map(entryPath => getArchiveEntryViewCachePath(bucket.name, file.path, entryPath)),
		]));
		runMutationTask(waitUntil, promise, 'Failed to purge /v deleted bucket cache:');
	});
}

registerViewHtmlCachePurgeListeners();

app.use('/v/*', resolveRouteCache({ externalMaxAgeSeconds: viewHtmlCacheMaxAgeSeconds }));

app.get('/v/*', async (c) => {
	const response = await c.env.ASSETS.fetch(c.req.raw);
	const context = await resolveViewFileContext(c);
	if (!context || !response.ok || !response.headers.get('Content-Type')?.includes('text/html')) return response;
	let extraHeadHtml = '';
	if (context.entryPath === null && context.mimeType === HLS_TAR_MIME) {
		const url = new URL(c.req.url);
		const metadata = await getHlsTarMetadata(c.env, getDb(c.env), {
			id: context.fileId,
			r2Key: context.r2Key,
			mimeType: context.mimeType,
			isTar: context.isTar,
		});
		if (metadata) {
			extraHeadHtml = buildHlsOgpHead({
				origin: url.origin,
				fileId: context.fileId,
				filePath: context.filePath,
				title: metadata.title,
				posterEntryPath: metadata.posterEntryPath,
				appName: await getAppName(c.env),
				pageUrl: `${url.origin}${url.pathname}`,
			});
		}
	}
	return withActivityPubAlternate(response, context.href, extraHeadHtml);
});

export const viewHtmlRoutes = app;
