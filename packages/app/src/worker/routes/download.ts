import { Hono, type Context } from 'hono';
import { eq, and, asc, sql } from 'drizzle-orm';
import { createBgzfBlock } from 'bgzf';
import parseRange from 'range-parser';
import { aidxRegExp, genEaidx, parseEaidx } from '../../shared/eaid-x';
import { buckets, files, targzFiles, tarFiles, tokens, users, fileAccessTokens, moderationAuditLogs } from '../scheme/index';
import { getDb } from '../utils/db';
import { DownloadContext, downloadCacheInternalHeaders } from '../utils/download-context';
import { MAX_FILE_PATH_LENGTH, MAX_ID_LENGTH } from '../../shared/const';
import { getWorkerCacheVersion, openWorkerCache, workerCacheBaseNames } from '../utils/cache-names';
import { apiError, createApiErrorResponse } from '../utils/api-error';
import { tokenToDigest } from '../utils/crypto';
import { likePrefix } from '../utils/sql-like';
import { selectStoredOrSniffedMimeType } from '../utils/mime-by-extension';

const app = new Hono<{ Bindings: Env }>();
const tenYearsInSeconds = 10 * 365 * 24 * 60 * 60;
type AppContext = Context<{ Bindings: Env }>;

type ByteRange = {
	start: number;
	end: number;
};

type RangeParseResult =
	| { type: 'range'; ranges: ByteRange[] }
	| { type: 'ignore' }
	| { type: 'invalid' };

const maxByteRanges = 16;

type ResolvedRangeRequest =
	| { type: 'none' }
	| { type: 'range'; ranges: ByteRange[] }
	| { type: 'invalid' };

function createMissingFileCacheRequest(fileId: string): Request {
	const keyUrl = new URL('https://cache.cfw-fileup.local/download-file-not-found');
	keyUrl.searchParams.set('v', '1');
	keyUrl.searchParams.set('fileId', fileId);
	return new Request(keyUrl, { method: 'GET' });
}

function toDownloadBasename(path: string): string {
	return path.split('/').pop() ?? 'download';
}

function addGzipExtensionForUngzipClients(filename: string, download: DownloadContext): string {
	return download.acceptsGzip ? filename : `${filename}.gz`;
}

function parseByteRange(rangeHeader: string | null, size: number): RangeParseResult {
	if (rangeHeader === null) return { type: 'ignore' };
	if (!Number.isSafeInteger(size) || size < 0) return { type: 'ignore' };

	const trimmedRangeHeader = rangeHeader.trim();
	const separatorIndex = trimmedRangeHeader.indexOf('=');
	if (separatorIndex === -1) return { type: 'invalid' };
	const unit = trimmedRangeHeader.slice(0, separatorIndex);
	const rangeSet = trimmedRangeHeader.slice(separatorIndex + 1);
	if (unit.toLowerCase() !== 'bytes') return { type: 'ignore' };

	const rangeSpecs = rangeSet.split(',');
	if (rangeSpecs.length > maxByteRanges) return { type: 'ignore' };
	for (const rangeSpec of rangeSpecs) {
		const trimmedRangeSpec = rangeSpec.trim();
		if (!/^\d*-\d*$/.test(trimmedRangeSpec)) return { type: 'invalid' };
		if (trimmedRangeSpec === '-') return { type: 'invalid' };
	}

	const parsed = parseRange(size, rangeHeader, { combine: true });
	if (parsed === -1) return { type: 'invalid' };
	if (parsed === -2) return { type: 'invalid' };
	if (parsed.type.toLowerCase() !== 'bytes') return { type: 'ignore' };
	if (parsed.length > maxByteRanges) return { type: 'ignore' };

	const ranges = Array.from(parsed, (range) => ({ start: range.start, end: range.end }));
	let previousStart = -1;
	for (const range of ranges) {
		if (range.start < previousStart) return { type: 'ignore' };
		previousStart = range.start;
	}
	return { type: 'range', ranges };
}

function sliceStream(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	range: ByteRange,
): ReadableStream<Uint8Array<ArrayBuffer>> {
	let position = 0;

	return stream.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
		transform(chunk, controller) {
			const chunkStart = position;
			const chunkEnd = position + chunk.byteLength - 1;
			position += chunk.byteLength;

			if (chunkEnd < range.start) return;
			if (chunkStart > range.end) return;

			const start = Math.max(range.start - chunkStart, 0);
			const end = Math.min(range.end - chunkStart + 1, chunk.byteLength);
			controller.enqueue(chunk.slice(start, end));
			if (chunkEnd >= range.end) controller.terminate();
		},
	}));
}

function multipartRangePartHeader(boundary: string, contentType: string, range: ByteRange, size: number): string {
	return `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Range: bytes ${range.start}-${range.end}/${size}\r\n\r\n`;
}

function multipartRangeContentLength(boundary: string, contentType: string, ranges: ByteRange[], size: number): number {
	const encoder = new TextEncoder();
	return ranges.reduce((sum, range) => {
		const headerLength = encoder.encode(multipartRangePartHeader(boundary, contentType, range, size)).byteLength;
		return sum + headerLength + (range.end - range.start + 1) + encoder.encode('\r\n').byteLength;
	}, encoder.encode(`--${boundary}--\r\n`).byteLength);
}

function sliceMultipartRangeStream(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	ranges: ByteRange[],
	size: number,
	boundary: string,
	contentType: string,
): ReadableStream<Uint8Array<ArrayBuffer>> {
	const encoder = new TextEncoder();
	let position = 0;
	let rangeIndex = 0;
	let wrotePartHeader = false;

	return stream.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
		transform(chunk, controller) {
			const chunkStart = position;
			const chunkEnd = position + chunk.byteLength - 1;
			position += chunk.byteLength;

			while (rangeIndex < ranges.length) {
				const range = ranges[rangeIndex];
				if (chunkEnd < range.start) return;
				if (chunkStart > range.end) {
					if (wrotePartHeader) controller.enqueue(encoder.encode('\r\n'));
					rangeIndex++;
					wrotePartHeader = false;
					continue;
				}

				if (!wrotePartHeader) {
					controller.enqueue(encoder.encode(multipartRangePartHeader(boundary, contentType, range, size)));
					wrotePartHeader = true;
				}

				const start = Math.max(range.start - chunkStart, 0);
				const end = Math.min(range.end - chunkStart + 1, chunk.byteLength);
				controller.enqueue(chunk.slice(start, end));

				if (chunkEnd < range.end) return;
				controller.enqueue(encoder.encode('\r\n'));
				rangeIndex++;
				wrotePartHeader = false;
			}

			controller.enqueue(encoder.encode(`--${boundary}--\r\n`));
			controller.terminate();
		},
		flush(controller) {
			if (rangeIndex < ranges.length && wrotePartHeader) controller.enqueue(encoder.encode('\r\n'));
			controller.enqueue(encoder.encode(`--${boundary}--\r\n`));
		},
	}));
}

function ifRangeMatches(headers: Headers, ifRangeHeader: string | null): boolean {
	if (ifRangeHeader === null) return true;

	const etag = headers.get('ETag');
	if (etag !== null) return ifRangeHeader.trim() === etag;

	const lastModified = headers.get('Last-Modified');
	if (lastModified === null) return false;
	return ifRangeHeader.trim() === lastModified;
}

function resolveRangeRequest(options: {
	rangeHeader: string | null;
	ifRangeHeader: string | null;
	size: number;
	headers: Headers;
}): ResolvedRangeRequest {
	if (options.rangeHeader === null || !ifRangeMatches(options.headers, options.ifRangeHeader)) return { type: 'none' };

	const range = parseByteRange(options.rangeHeader, options.size);
	if (range.type === 'ignore') return { type: 'none' };
	if (range.type === 'invalid') return { type: 'invalid' };
	return { type: 'range', ranges: range.ranges };
}

function createUnsatisfiableRangeResponse(sourceHeaders: Headers, size: number): Response {
	const headers = new Headers();
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Content-Range', `bytes */${size}`);
	const cacheControl = sourceHeaders.get('Cache-Control');
	if (cacheControl !== null) headers.set('Cache-Control', cacheControl);
	const vary = sourceHeaders.get('Vary');
	if (vary !== null) headers.set('Vary', vary);
	return new Response(null, {
		status: 416,
		statusText: 'Range Not Satisfiable',
		headers,
	});
}

function applyRangeRequest(response: Response, rangeHeader: string | null, ifRangeHeader: string | null): Response {
	const headers = new Headers(response.headers);
	const sizeText = headers.get('Content-Length');
	const size = sizeText === null ? Number.NaN : Number(sizeText);
	const canServeRange = response.status === 200 && Number.isSafeInteger(size) && size >= 0;
	if (canServeRange) headers.set('Accept-Ranges', 'bytes');

	if (!canServeRange || rangeHeader === null) {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	const range = resolveRangeRequest({ rangeHeader, ifRangeHeader, size, headers });
	if (range.type === 'none') {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	if (range.type === 'invalid') {
		response.body?.cancel().catch(() => {});
		return createUnsatisfiableRangeResponse(headers, size);
	}

	if (range.ranges.length > 1) {
		if (headers.has('Content-Encoding')) {
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}
		const contentType = headers.get('Content-Type') ?? 'application/octet-stream';
		const boundary = `cfw-fileup-${crypto.randomUUID()}`;
		headers.set('Content-Type', `multipart/byteranges; boundary=${boundary}`);
		headers.delete('Content-Disposition');
		headers.delete('Content-Range');
		headers.set('Content-Length', String(multipartRangeContentLength(boundary, contentType, range.ranges, size)));
		return new Response(
			response.body === null ? null : sliceMultipartRangeStream(response.body, range.ranges, size, boundary, contentType),
			{
				status: 206,
				statusText: 'Partial Content',
				headers,
			},
		);
	}

	const singleRange = range.ranges[0];
	const length = singleRange.end - singleRange.start + 1;
	headers.set('Content-Range', `bytes ${singleRange.start}-${singleRange.end}/${size}`);
	headers.set('Content-Length', String(length));
	return new Response(
		response.body === null ? null : sliceStream(response.body, singleRange),
		{
			status: 206,
			statusText: 'Partial Content',
			headers,
		},
	);
}

function shouldCountDownload(resolvedRange: ResolvedRangeRequest): boolean {
	if (resolvedRange.type === 'none') return true;
	if (resolvedRange.type === 'invalid') return false;
	return resolvedRange.ranges.some(r => r.start === 0);
}

function createMultipartRangeStreamFromR2(options: {
	r2: R2Bucket;
	key: string;
	ranges: ByteRange[];
	size: number;
	boundary: string;
	contentType: string;
}): ReadableStream<Uint8Array<ArrayBuffer>> {
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array<ArrayBuffer>>({
		async start(controller) {
			for (const range of options.ranges) {
				controller.enqueue(encoder.encode(multipartRangePartHeader(options.boundary, options.contentType, range, options.size)));
				const object = await options.r2.get(options.key, {
					range: {
						offset: range.start,
						length: range.end - range.start + 1,
					},
				});
				if (!object?.body) throw new Error('Failed to retrieve range from R2');
				const reader = object.body.getReader();
				try {
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						controller.enqueue(value);
					}
				} finally {
					reader.releaseLock();
				}
				controller.enqueue(encoder.encode('\r\n'));
			}
			controller.enqueue(encoder.encode(`--${options.boundary}--\r\n`));
			controller.close();
		},
	});
}

const VALID_MIME_TYPE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;
const mimeSniffBytes = 512;

function selectEntryMimeType(storedMimeType: string, entryPath: string, sniffBytes: Uint8Array): string {
	return selectStoredOrSniffedMimeType({
		path: entryPath,
		storedMimeType,
		sniffBytes,
		isValidStoredMimeType: mimeType => VALID_MIME_TYPE.test(mimeType),
	});
}

function getTargzEntryHeaders(download: DownloadContext, path: string, mimeType: string): HeadersInit {
	const headers = new Headers({
		'Content-Type': mimeType,
		'Content-Disposition': download.createContentDisposition(path, addGzipExtensionForUngzipClients),
		'ETag': download.getETag(path),
	});
	if (download.acceptsGzip) {
		headers.set('Content-Encoding', 'gzip');
	}
	return download.withDownloadHeaders(headers);
}

function createPlainFileHeaders(download: DownloadContext): Headers {
	return new Headers(download.withDownloadHeaders({
		'Content-Type': download.file.mimeType ?? 'application/octet-stream',
		'Content-Disposition': download.createContentDisposition(toDownloadBasename(download.file.path)),
		'Content-Length': String(download.file.size ?? 0),
	}));
}

function addAcceptRangesForFullResponse(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set('Accept-Ranges', 'bytes');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function stripInternalCacheHeaders(cached: Response): Response {
	const headers = new Headers(cached.headers);
	const cachedStatus = Number(headers.get(downloadCacheInternalHeaders.status));
	const status = Number.isInteger(cachedStatus) && cachedStatus >= 100 && cachedStatus <= 599
		? cachedStatus
		: cached.status;
	const statusText = headers.get(downloadCacheInternalHeaders.statusText) ?? cached.statusText;
	headers.delete(downloadCacheInternalHeaders.status);
	headers.delete(downloadCacheInternalHeaders.statusText);
	return new Response(cached.body, {
		status,
		statusText,
		headers,
	});
}

async function matchMissingFileCache(env: Env, fileId: string): Promise<Response | null> {
	const cacheRequest = createMissingFileCacheRequest(fileId);
	const cache = await openWorkerCache(env, workerCacheBaseNames.missingDownloadFile);
	const cached = await cache.match(cacheRequest);
	if (cached === undefined) return null;

	const expires = cached.headers.get('Expires');
	if (expires !== null) {
		const expiresAt = Date.parse(expires);
		if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
			await cache.delete(cacheRequest);
			return null;
		}
	}

	return stripInternalCacheHeaders(cached);
}

function createMissingFileResponse(fileId: string): Response {
	const fileDate = parseEaidx(fileId).date;
	const now = Date.now();
	const expiresAt = fileDate.getTime() > now
		? fileDate.getTime()
		: now + tenYearsInSeconds * 1000;
	const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));

	return new Response(JSON.stringify(createApiErrorResponse('FILE_NOT_FOUND')), {
		status: 404,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': `public, max-age=${maxAge}`,
			'Expires': new Date(expiresAt).toUTCString(),
		},
	});
}

function putMissingFileCache(env: Env, fileId: string, response: Response, waitUntil: (promise: Promise<void>) => void): void {
	const cacheResponse = response.clone();
	const putPromise = (async () => {
		const cache = await openWorkerCache(env, workerCacheBaseNames.missingDownloadFile);
		const headers = new Headers(cacheResponse.headers);
		headers.set(downloadCacheInternalHeaders.status, String(cacheResponse.status));
		headers.set(downloadCacheInternalHeaders.statusText, cacheResponse.statusText);
		await cache.put(createMissingFileCacheRequest(fileId), new Response(cacheResponse.body, {
			status: 200,
			statusText: 'OK',
			headers,
		}));
	})();

	try {
		waitUntil(putPromise);
	} catch {
		void putPromise.catch((error: unknown) => {
			console.error('Failed to put missing file response into cache:', error);
		});
	}
}

async function decompressGzipChunk(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const decompressor = new DecompressionStream('gzip');
	const chunks: Uint8Array[] = [];

	const writePromise = (async () => {
		const writer = decompressor.writable.getWriter();
		await writer.write(new Uint8Array(data));
		await writer.close();
	})();

	const readPromise = (async () => {
		const reader = decompressor.readable.getReader();
		try {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value instanceof Uint8Array) {
					chunks.push(value);
				}
			}
		} finally {
			reader.releaseLock();
		}
	})();

	await Promise.all([writePromise, readPromise]);

	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

async function readR2ObjectBody(body: ReadableStream<Uint8Array<ArrayBuffer>>, controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>): Promise<void> {
	const reader = body.getReader();
	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			controller.enqueue(value);
		}
	} finally {
		reader.releaseLock();
	}
}

async function handleDownload(c: AppContext, entryPath: string | null): Promise<Response> {
	const db = getDb(c.env);
	const fileId = c.req.param('fileId') ?? '';
	if (fileId.length > MAX_ID_LENGTH) throw apiError(400, 'FILE_ID_IS_REQUIRED', `fileId must be at most ${MAX_ID_LENGTH} characters`);
	if (!aidxRegExp.test(fileId)) throw apiError(400, 'INVALID_FILE_ID');
	const cachedMissingFile = await matchMissingFileCache(c.env, fileId);
	if (cachedMissingFile !== null) return cachedMissingFile;

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();
	if (!file) {
		const response = createMissingFileResponse(fileId);
		putMissingFileCache(c.env, fileId, response, (promise) => c.executionCtx.waitUntil(promise));
		return response;
	}
	if (!file.isClosed) {
		throw apiError(404, 'FILE_NOT_FOUND');
	}
	const fileRecord = file;
	const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();
	if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');

	const workerCacheVersion = await getWorkerCacheVersion(c.env);
	const download = new DownloadContext(file, c.req.raw, { entryPath, cacheVersion: workerCacheVersion });
	const rangeHeader = c.req.header('Range') ?? null;
	const ifRangeHeader = c.req.header('If-Range') ?? null;
	let requesterIsOwnerPromise: Promise<boolean> | null = null;

	function requesterIsOwner(): Promise<boolean> {
		requesterIsOwnerPromise ??= (async () => {
			const authorization = c.req.header('Authorization');
			if (!authorization?.startsWith('Bearer ')) return false;
			const token = authorization.slice(7);
			const tokenBytes = await tokenToDigest(token);
			const tokenRecord = await db
				.select({ userId: tokens.userId, isSuspended: users.isSuspended, isRevoked: tokens.isRevoked })
				.from(tokens)
				.innerJoin(users, eq(tokens.userId, users.id))
				.where(tokenBytes === null ? sql`false` : eq(tokens.token, tokenBytes))
				.get();
			return !!tokenRecord && !tokenRecord.isRevoked && !tokenRecord.isSuspended && tokenRecord.userId === fileRecord.userId;
		})();
		return requesterIsOwnerPromise;
	}

	async function countDownload(resolvedRange: ResolvedRangeRequest = { type: 'none' }): Promise<void> {
		if (!fileRecord.isDownloadCountEnabled) return;
		if (!shouldCountDownload(resolvedRange)) return;
		if (await requesterIsOwner()) return;
		await db
			.update(files)
			.set({ downloadCount: sql`${files.downloadCount} + 1` })
			.where(eq(files.id, fileRecord.id));
	}

	if (download.entryPath !== null && download.entryPath.length > MAX_FILE_PATH_LENGTH) {
		throw apiError(400, 'INVALID_FILE_PATH', `file must be at most ${MAX_FILE_PATH_LENGTH} characters`);
	}

	async function matchDownloadCache(
		mode: Parameters<DownloadContext['getCacheRequest']>[0],
		entryPath?: string,
	): Promise<Response | null> {
		const cacheRequest = download.getCacheRequest(mode, entryPath);
		if (cacheRequest === null) return null;
		const cache = await openWorkerCache(c.env, workerCacheBaseNames.download);
		const cached = await cache.match(cacheRequest);
		if (cached === undefined) return null;

		const expires = cached.headers.get('Expires');
		if (expires !== null) {
			const expiresAt = Date.parse(expires);
			if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
				await cache.delete(cacheRequest);
				return null;
			}
		}

		const response = download.stripInternalCacheHeaders(cached, mode);
		return mode === 'plain'
			? applyRangeRequest(response, rangeHeader, ifRangeHeader)
			: response;
	}

	function putDownloadCache(
		response: Response,
		mode: Parameters<DownloadContext['getCacheRequest']>[0],
		entryPath?: string,
	): void {
		const cacheRequest = download.getCacheRequest(mode, entryPath);
		if (cacheRequest === null) return;
		const cacheResponse = response.clone();
		const putPromise = (async () => {
			const cache = await openWorkerCache(c.env, workerCacheBaseNames.download);
			const headers = new Headers(cacheResponse.headers);
			headers.set('Cache-Control', download.getInternalCacheControl());
			headers.set(downloadCacheInternalHeaders.status, String(cacheResponse.status));
			headers.set(downloadCacheInternalHeaders.statusText, cacheResponse.statusText);
			await cache.put(cacheRequest, new Response(cacheResponse.body, {
				status: 200,
				statusText: 'OK',
				headers,
				...(mode === 'targz-entry' ? { encodeBody: 'manual' } : {}),
			}));
		})();

		try {
			c.executionCtx.waitUntil(putPromise);
		} catch {
			void putPromise.catch((error: unknown) => {
				console.error('Failed to put download response into cache:', error);
			});
		}
	}

	if (file.visibility !== 'public' || file.isModerationForcedPrivate) {
		const fileToken = c.req.query('token');
		if (fileToken && !file.isModerationForcedPrivate) {
			if (fileToken.length > MAX_ID_LENGTH) throw apiError(400, 'TOKEN_IS_REQUIRED', `token must be at most ${MAX_ID_LENGTH} characters`);
			const fileTokenBytes = await tokenToDigest(fileToken);
			const fileTokenRecord = await db
				.select()
				.from(fileAccessTokens)
				.where(and(fileTokenBytes === null ? sql`false` : eq(fileAccessTokens.token, fileTokenBytes), eq(fileAccessTokens.fileId, file.id)))
				.get();
			if (!fileTokenRecord) throw apiError(403, 'FORBIDDEN');
			if (fileTokenRecord.expiresAt !== null && fileTokenRecord.expiresAt < Date.now()) {
				download.useExpiredFileToken(fileTokenRecord);
				const cacheTarget = download.cacheTarget;
				if (cacheTarget !== null) {
					const cached = await matchDownloadCache(cacheTarget.mode, cacheTarget.entryPath);
					if (cached !== null) return cached;
				}
				const response = new Response('Forbidden', { status: 403 });
				if (cacheTarget !== null) putDownloadCache(response, cacheTarget.mode, cacheTarget.entryPath);
				return applyRangeRequest(response, rangeHeader, ifRangeHeader);
			}
			download.useFileToken(fileTokenRecord);
		} else {
			const authorization = c.req.header('Authorization');
			if (!authorization?.startsWith('Bearer ')) throw apiError(403, 'FORBIDDEN');
			const token = authorization.slice(7);
			const tokenBytes = await tokenToDigest(token);
			const tokenRecord = await db
				.select({ tokenId: tokens.id, userId: tokens.userId, isAdmin: users.isAdmin, isModerator: users.isModerator, isSuspended: users.isSuspended, isRevoked: tokens.isRevoked })
				.from(tokens)
				.innerJoin(users, eq(tokens.userId, users.id))
				.where(tokenBytes === null ? sql`false` : eq(tokens.token, tokenBytes))
				.get();
			if (!tokenRecord || tokenRecord.isRevoked || tokenRecord.isSuspended || (!tokenRecord.isAdmin && !tokenRecord.isModerator && tokenRecord.userId !== bucket.userId)) {
				throw apiError(403, 'FORBIDDEN');
			}
			if ((tokenRecord.isAdmin || tokenRecord.isModerator) && tokenRecord.userId !== bucket.userId) {
				await db.insert(moderationAuditLogs).values({
					id: genEaidx(Date.now()),
					adminUserId: tokenRecord.userId,
					action: 'admin_file_previewed',
					targetFileId: file.id,
					targetUserId: file.userId,
					data: {
						bucketId: bucket.id,
						bucketName: bucket.name,
						path: file.path,
						visibility: file.visibility,
						isModerationForcedPrivate: file.isModerationForcedPrivate,
						entryPath,
					},
				});
			}
		}
	}

	if (download.isMetaMode) {
		return c.json({
			type: 'file',
			path: file.path,
			size: file.size,
			mimeType: file.mimeType,
			isTargz: file.isTargz,
			isTar: file.isTar,
			isEncrypted: file.isEncrypted,
			visibility: file.visibility,
		});
	}

	const cacheTarget = download.cacheTarget;
	if (cacheTarget !== null) {
		const plainRange = cacheTarget.mode === 'plain'
			? resolveRangeRequest({
				rangeHeader,
				ifRangeHeader,
				size: file.size ?? 0,
				headers: createPlainFileHeaders(download),
			})
			: { type: 'none' } satisfies ResolvedRangeRequest;
		if (plainRange.type === 'invalid') {
			return createUnsatisfiableRangeResponse(createPlainFileHeaders(download), file.size ?? 0);
		}
		// Plain-file ranges are faster from R2 ranged reads than from scanning cached full bodies.
		const shouldBypassCache = plainRange.type === 'range';
		if (!shouldBypassCache) {
			const cached = await matchDownloadCache(cacheTarget.mode, cacheTarget.entryPath);
			if (cached !== null) {
				await countDownload(plainRange);
				return cached;
			}
		}
	}

	if ((file.isTargz || file.isTar) && download.isListMode) {
		const listPath = c.req.query('list');
		if (listPath && listPath.length > MAX_FILE_PATH_LENGTH) {
			throw apiError(400, 'INVALID_FILE_PATH', `list must be at most ${MAX_FILE_PATH_LENGTH} characters`);
		}
		if (file.isTargz) {
			const index = await db.select().from(targzFiles).where(
				listPath
					? and(eq(targzFiles.fileId, file.id), likePrefix(targzFiles.path, listPath))
					: eq(targzFiles.fileId, file.id),
			).orderBy(asc(targzFiles.aStart), asc(targzFiles.rStartOffset), asc(targzFiles.id));
			return c.json(index);
		} else {
			const index = await db.select().from(tarFiles).where(
				listPath
					? and(eq(tarFiles.fileId, file.id), likePrefix(tarFiles.path, listPath))
					: eq(tarFiles.fileId, file.id),
			).orderBy(asc(tarFiles.offset), asc(tarFiles.id));
			return c.json(index);
		}
	}

	const requestedEntryPath = download.entryPath;
	if (download.isTarFileEntry && requestedEntryPath !== null) {
		const indexEntry = await db
			.select()
			.from(tarFiles)
			.where(and(eq(tarFiles.fileId, file.id), eq(tarFiles.path, requestedEntryPath)))
			.get();

		if (!indexEntry) {
			throw apiError(404, 'FILE_NOT_FOUND_IN_ARCHIVE');
		}

		const rangeData = await c.env.R2.get(file.r2Key, {
			range: { offset: indexEntry.offset, length: indexEntry.size },
		});
		if (!rangeData?.body) {
			throw apiError(500, 'FAILED_TO_RETRIEVE_FILE');
		}
		const sniffData = indexEntry.size > 0
			? await c.env.R2.get(file.r2Key, {
				range: {
					offset: indexEntry.offset,
					length: Math.min(indexEntry.size, mimeSniffBytes),
				},
			})
			: null;
		const sniffBytes = sniffData?.body
			? new Uint8Array(await sniffData.arrayBuffer())
			: new Uint8Array(0);

		const response = new Response(rangeData.body, {
			headers: download.withDownloadHeaders({
				'Content-Type': selectEntryMimeType(indexEntry.mimeType, indexEntry.path, sniffBytes),
				'Content-Disposition': download.createContentDisposition(toDownloadBasename(indexEntry.path)),
				'Content-Length': String(indexEntry.size),
			}),
		});
		putDownloadCache(response, 'tar-entry', requestedEntryPath);
		await countDownload();
		return response;
	}

	if (download.isTargzFileEntry && requestedEntryPath !== null) {
		const indexEntry = await db
			.select()
			.from(targzFiles)
			.where(and(eq(targzFiles.fileId, file.id), eq(targzFiles.path, requestedEntryPath)))
			.get();

		if (!indexEntry) {
			throw apiError(404, 'FILE_NOT_FOUND_IN_ARCHIVE');
		}

		try {
			const isSingleBlock = indexEntry.aStart === indexEntry.aFinalStart;

			const firstBlockData = await c.env.R2.get(file.r2Key, {
				range: {
					offset: indexEntry.aStart,
					length: indexEntry.aFirstEnd - indexEntry.aStart,
				},
			});
			if (!firstBlockData?.body) {
				throw apiError(404, 'FAILED_TO_RETRIEVE_FILE');
			}

			const firstBytes = await firstBlockData.arrayBuffer();
			const firstDecompressed = await decompressGzipChunk(new Uint8Array(firstBytes));
			const firstTrimmed = isSingleBlock
				? firstDecompressed.slice(indexEntry.rStartOffset, firstDecompressed.length - indexEntry.rEndOffset)
				: firstDecompressed.slice(indexEntry.rStartOffset);
			const firstBgzfBlock = await createBgzfBlock(firstTrimmed);
			const sniffBytes = firstTrimmed.slice(0, mimeSniffBytes);

			const intermediateData = !isSingleBlock && indexEntry.aFirstEnd < indexEntry.aFinalStart
				? await c.env.R2.get(file.r2Key, {
					range: {
						offset: indexEntry.aFirstEnd,
						length: indexEntry.aFinalStart - indexEntry.aFirstEnd,
					},
				})
				: null;

			let lastBgzfBlock: Uint8Array<ArrayBuffer> | null = null;
			if (!isSingleBlock && indexEntry.aFinalStart < indexEntry.aEnd) {
				const lastBlockData = await c.env.R2.get(file.r2Key, {
					range: {
						offset: indexEntry.aFinalStart,
						length: indexEntry.aEnd - indexEntry.aFinalStart,
					},
				});
				if (!lastBlockData?.body) {
					throw apiError(404, 'FAILED_TO_RETRIEVE_FILE');
				}
				const lastBytes = await lastBlockData.arrayBuffer();
				const lastDecompressed = await decompressGzipChunk(new Uint8Array(lastBytes));
				const endTrimmed = lastDecompressed.slice(0, lastDecompressed.length - indexEntry.rEndOffset);
				lastBgzfBlock = await createBgzfBlock(endTrimmed);
			}

			const combinedStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
				async start(controller) {
					try {
						controller.enqueue(firstBgzfBlock);
						if (intermediateData?.body) {
							await readR2ObjectBody(intermediateData.body, controller);
						}
						if (lastBgzfBlock !== null) {
							controller.enqueue(lastBgzfBlock);
						}
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				},
			});

			const response = new Response(combinedStream, {
				headers: getTargzEntryHeaders(download, indexEntry.path, selectEntryMimeType(indexEntry.mimeType, indexEntry.path, sniffBytes)),
				encodeBody: 'manual',
			});
			putDownloadCache(response, 'targz-entry', requestedEntryPath);
			await countDownload();
			return response;
		} catch (error) {
			console.error('Failed to fetch from R2:', error);
			throw apiError(500, 'INTERNAL_SERVER_ERROR');
		}
	}

	const plainHeaders = createPlainFileHeaders(download);
	const plainSize = Number(plainHeaders.get('Content-Length'));
	const plainRange = Number.isSafeInteger(plainSize) && plainSize >= 0
		? resolveRangeRequest({ rangeHeader, ifRangeHeader, size: plainSize, headers: plainHeaders })
		: { type: 'none' } satisfies ResolvedRangeRequest;

	if (plainRange.type === 'invalid') {
		return createUnsatisfiableRangeResponse(plainHeaders, plainSize);
	}

	if (plainRange.type === 'range') {
		if (plainRange.ranges.length === 1) {
			const singleRange = plainRange.ranges[0];
			const rangeObject = await c.env.R2.get(file.r2Key, {
				range: {
					offset: singleRange.start,
					length: singleRange.end - singleRange.start + 1,
				},
			});
			if (!rangeObject?.body) {
				const cached = await matchDownloadCache('plain');
				if (cached !== null) {
					await countDownload(plainRange);
					return cached;
				}
				throw apiError(404, 'FILE_NOT_FOUND_IN_STORAGE');
			}

			plainHeaders.set('Accept-Ranges', 'bytes');
			plainHeaders.set('Content-Range', `bytes ${singleRange.start}-${singleRange.end}/${plainSize}`);
			plainHeaders.set('Content-Length', String(singleRange.end - singleRange.start + 1));

			await countDownload(plainRange);
			return new Response(rangeObject.body, {
				status: 206,
				statusText: 'Partial Content',
				headers: plainHeaders,
			});
		}

		const rangeSource = await c.env.R2.head(file.r2Key);
		if (rangeSource === null) {
			const cached = await matchDownloadCache('plain');
			if (cached !== null) {
				await countDownload(plainRange);
				return cached;
			}
			throw apiError(404, 'FILE_NOT_FOUND_IN_STORAGE');
		}

		const contentType = plainHeaders.get('Content-Type') ?? 'application/octet-stream';
		const boundary = `cfw-fileup-${crypto.randomUUID()}`;
		plainHeaders.set('Accept-Ranges', 'bytes');
		plainHeaders.set('Content-Type', `multipart/byteranges; boundary=${boundary}`);
		plainHeaders.delete('Content-Disposition');
		plainHeaders.delete('Content-Range');
		plainHeaders.set('Content-Length', String(multipartRangeContentLength(boundary, contentType, plainRange.ranges, plainSize)));

		await countDownload(plainRange);
		return new Response(createMultipartRangeStreamFromR2({
			r2: c.env.R2,
			key: file.r2Key,
			ranges: plainRange.ranges,
			size: plainSize,
			boundary,
			contentType,
		}), {
			status: 206,
			statusText: 'Partial Content',
			headers: plainHeaders,
		});
	}

	const r2Object = await c.env.R2.get(file.r2Key);

	if (!r2Object) {
		throw apiError(404, 'FILE_NOT_FOUND_IN_STORAGE');
	}

	const response = new Response(r2Object.body, {
		headers: plainHeaders,
	});
	putDownloadCache(response, 'plain');
	await countDownload(plainRange);
	return rangeHeader === null && ifRangeHeader === null
		? addAcceptRangesForFullResponse(response)
		: applyRangeRequest(response, rangeHeader, ifRangeHeader);
}

app.get('/d/:fileId/:entryMarker/:entryPath{.+}', async (c) => {
	const entryMarker = c.req.param('entryMarker');
	if (entryMarker !== ':entries') throw apiError(404, 'FILE_NOT_FOUND');
	return handleDownload(c, c.req.param('entryPath'));
});

app.get('/d/:fileId', async (c) => handleDownload(c, null));

export const downloadRoutes = app;
