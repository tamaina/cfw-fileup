import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, like } from 'drizzle-orm';
import { createBgzfBlock } from 'bgzf';
import { buckets, files, targzFiles, tarFiles, tokens, users, fileAccessTokens } from '../scheme/index';
import { getDb } from '../utils/db';
import { DownloadContext, downloadCacheInternalHeaders } from '../utils/download-context';

const app = new Hono<{ Bindings: Env }>();
const downloadCacheName = 'download';

async function decompressGzipChunk(data: Uint8Array): Promise<Uint8Array> {
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

app.get('/d/:fileId', async (c) => {
	const db = getDb(c.env);
	const fileId = c.req.param('fileId');
	const file = await db.select().from(files).where(eq(files.id, fileId)).get();
	if (!file) throw new HTTPException(404, { message: 'File not found' });
	const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();
	if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });

	const download = new DownloadContext(file, c.req.raw);

	if (download.isMetaMode) {
		return c.json({
			type: 'file',
			path: file.path,
			size: file.size,
			mimeType: file.mimeType,
			isTargz: file.isTargz,
			isTar: file.isTar,
			visibility: file.visibility,
		});
	}

	async function matchDownloadCache(
		mode: Parameters<DownloadContext['getCacheRequest']>[0],
		entryPath?: string,
	): Promise<Response | null> {
		const cacheRequest = download.getCacheRequest(mode, entryPath);
		if (cacheRequest === null) return null;
		const cache = await caches.open(downloadCacheName);
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

		return download.stripInternalCacheHeaders(cached);
	}

	function putDownloadCache(
		response: Response,
		mode: Parameters<DownloadContext['getCacheRequest']>[0],
		entryPath?: string,
	): void {
		const cacheRequest = download.getCacheRequest(mode, entryPath);
		if (cacheRequest === null) return;
		const putPromise = (async () => {
			const cache = await caches.open(downloadCacheName);
			const cacheResponse = response.clone();
			const headers = new Headers(cacheResponse.headers);
			headers.set('Cache-Control', download.getInternalCacheControl());
			headers.set(downloadCacheInternalHeaders.status, String(cacheResponse.status));
			headers.set(downloadCacheInternalHeaders.statusText, cacheResponse.statusText);
			await cache.put(cacheRequest, new Response(cacheResponse.body, {
				status: 200,
				statusText: 'OK',
				headers,
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

	if (file.visibility !== 'public') {
		const fileToken = c.req.query('token');
		if (fileToken) {
			const fileTokenRecord = await db
				.select()
				.from(fileAccessTokens)
				.where(and(eq(fileAccessTokens.token, fileToken), eq(fileAccessTokens.fileId, file.id)))
				.get();
			if (!fileTokenRecord) throw new HTTPException(403, { message: 'Forbidden' });
			if (fileTokenRecord.expiresAt !== null && fileTokenRecord.expiresAt < Date.now()) {
				download.useExpiredFileToken(fileTokenRecord);
				const cacheTarget = download.cacheTarget;
				if (cacheTarget !== null) {
					const cached = await matchDownloadCache(cacheTarget.mode, cacheTarget.entryPath);
					if (cached !== null) return cached;
				}
				const response = new Response('Forbidden', { status: 403 });
				if (cacheTarget !== null) putDownloadCache(response, cacheTarget.mode, cacheTarget.entryPath);
				return response;
			}
			download.useFileToken(fileTokenRecord);
		} else {
			const authorization = c.req.header('Authorization');
			if (!authorization?.startsWith('Bearer ')) throw new HTTPException(403, { message: 'Forbidden' });
			const token = authorization.slice(7);
			const tokenRecord = await db
				.select({ userId: tokens.userId, isAdmin: users.isAdmin, isSuspended: users.isSuspended })
				.from(tokens)
				.innerJoin(users, eq(tokens.userId, users.id))
				.where(eq(tokens.token, token))
				.get();
			if (!tokenRecord || tokenRecord.isSuspended || (!tokenRecord.isAdmin && tokenRecord.userId !== bucket.userId)) {
				throw new HTTPException(403, { message: 'Forbidden' });
			}
		}
	}

	const cacheTarget = download.cacheTarget;
	if (cacheTarget !== null) {
		const cached = await matchDownloadCache(cacheTarget.mode, cacheTarget.entryPath);
		if (cached !== null) return cached;
	}

	if ((file.isTargz || file.isTar) && download.isListMode) {
		const listPath = c.req.query('list');
		if (file.isTargz) {
			const index = await db.select().from(targzFiles).where(
				listPath
					? and(eq(targzFiles.fileId, file.id), like(targzFiles.path, `${listPath}%`))
					: eq(targzFiles.fileId, file.id),
			);
			return c.json(index);
		} else {
			const index = await db.select().from(tarFiles).where(
				listPath
					? and(eq(tarFiles.fileId, file.id), like(tarFiles.path, `${listPath}%`))
					: eq(tarFiles.fileId, file.id),
			);
			return c.json(index);
		}
	}

	const fileQuery = download.fileQuery;
	if (download.isTarFileEntry && fileQuery !== null) {
		const indexEntry = await db
			.select()
			.from(tarFiles)
			.where(and(eq(tarFiles.fileId, file.id), eq(tarFiles.path, fileQuery)))
			.get();

		if (!indexEntry) {
			throw new HTTPException(404, { message: 'File not found in archive' });
		}

		const rangeData = await c.env.R2.get(file.r2Key, {
			range: { offset: indexEntry.offset, length: indexEntry.size },
		});
		if (!rangeData?.body) {
			throw new HTTPException(500, { message: 'Failed to retrieve file' });
		}

		const response = new Response(rangeData.body, {
			headers: download.withDownloadHeaders({
				'Content-Type': indexEntry.mimeType,
				'Content-Disposition': `attachment; filename="${indexEntry.path.split('/').pop()}"`,
				'Content-Length': String(indexEntry.size),
			}),
		});
		putDownloadCache(response, 'tar-entry', fileQuery);
		return response;
	}

	if (download.isTargzFileEntry && fileQuery !== null) {
		const indexEntry = await db
			.select()
			.from(targzFiles)
			.where(and(eq(targzFiles.fileId, file.id), eq(targzFiles.path, fileQuery)))
			.get();

		if (!indexEntry) {
			throw new HTTPException(404, { message: 'File not found in archive' });
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
				throw new HTTPException(404, { message: 'Failed to retrieve file' });
			}

			const firstBytes = await firstBlockData.arrayBuffer();
			const firstDecompressed = await decompressGzipChunk(new Uint8Array(firstBytes));
			const firstTrimmed = isSingleBlock
				? firstDecompressed.slice(indexEntry.rStartOffset, firstDecompressed.length - indexEntry.rEndOffset)
				: firstDecompressed.slice(indexEntry.rStartOffset);
			const firstBgzfBlock = await createBgzfBlock(firstTrimmed);

			const combinedStream = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(firstBgzfBlock);

					if (!isSingleBlock && indexEntry.aFirstEnd < indexEntry.aFinalStart) {
						const intermediateData = await c.env.R2.get(file.r2Key, {
							range: {
								offset: indexEntry.aFirstEnd,
								length: indexEntry.aFinalStart - indexEntry.aFirstEnd,
							},
						});
						if (intermediateData?.body) {
							const reader = intermediateData.body.getReader();
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
					}

					if (!isSingleBlock && indexEntry.aFinalStart < indexEntry.aEnd) {
						const lastBlockData = await c.env.R2.get(file.r2Key, {
							range: {
								offset: indexEntry.aFinalStart,
								length: indexEntry.aEnd - indexEntry.aFinalStart,
							},
						});
						if (lastBlockData?.body) {
							const lastBytes = await lastBlockData.arrayBuffer();
							const lastDecompressed = await decompressGzipChunk(new Uint8Array(lastBytes));
							const endTrimmed = lastDecompressed.slice(0, lastDecompressed.length - indexEntry.rEndOffset);
							const lastBgzfBlock = await createBgzfBlock(endTrimmed);
							controller.enqueue(lastBgzfBlock);
						}
					}

					controller.close();
				},
			});

			const response = new Response(combinedStream, {
				headers: download.withDownloadHeaders({
					'Content-Type': indexEntry.mimeType,
					'Content-Encoding': 'gzip',
					'Content-Disposition': download.getContentDisposition(indexEntry.path),
					'ETag': download.getETag(indexEntry.path),
				}),
			});
			putDownloadCache(response, 'targz-entry', fileQuery);
			return response;
		} catch (error) {
			console.error('Failed to fetch from R2:', error);
			throw new HTTPException(500, { message: 'Internal server error' });
		}
	}

	const r2Object = await c.env.R2.get(file.r2Key);

	if (!r2Object) {
		throw new HTTPException(404, { message: 'File not found in storage' });
	}

	const response = new Response(r2Object.body, {
		headers: download.withDownloadHeaders({
			'Content-Type': file.mimeType ?? 'application/octet-stream',
			'Content-Length': String(file.size ?? 0),
		}),
	});
	putDownloadCache(response, 'plain');
	return response;
});

export const downloadRoutes = app;
