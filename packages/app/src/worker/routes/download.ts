import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { buckets, files, targzFiles } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { createBgzfBlock } from 'bgzf';

const app = new Hono<{ Bindings: Env }>();

function getContentDisposition(filename: string, acceptsGzip: boolean): string {
	const displayName = acceptsGzip ? filename : `${filename}.gz`;
	return `attachment; filename="${displayName}"`;
}

function getETag(baseETag: string, acceptsGzip: boolean): string {
	return acceptsGzip ? baseETag : `${baseETag}-gz`;
}

async function decompressGzipChunk(data: Uint8Array): Promise<Uint8Array> {
	const decompressor = new DecompressionStream('gzip');
	const writer = decompressor.writable.getWriter();
	const normalizedData = new Uint8Array(data);
	await writer.write(normalizedData);
	await writer.close();

	const chunks: Uint8Array[] = [];
	const reader = decompressor.readable.getReader();
	try {
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

	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

app.get('/d/:bucketName/*', async (c) => {
	const db = getDb(c.env);
	const bucketName = c.req.param('bucketName');
	const filePath = c.req.path.replace(`/d/${bucketName}/`, '');
	const acceptEncoding = c.req.header('Accept-Encoding') || '';
	const acceptsGzip = acceptEncoding.includes('gzip');

	const bucket = await db.select().from(buckets).where(eq(buckets.name, bucketName)).get();

	if (!bucket) {
		throw new HTTPException(404, { message: 'Bucket not found' });
	}

	const file = await db
		.select()
		.from(files)
		.where(and(eq(files.bucketId, bucket.id), eq(files.path, filePath)))
		.get();

	if (!file) {
		throw new HTTPException(404, { message: 'File not found' });
	}

	if (!file.isPublic) {
		const passphrase = c.req.query('passphrase');
		if (!passphrase || passphrase !== file.passphrase) {
			throw new HTTPException(403, { message: 'Forbidden' });
		}
	}

	if (file.isTargz && c.req.query('list') !== undefined) {
		const listPath = c.req.query('list');
		let index;

		if (listPath && typeof listPath === 'string') {
			index = await db
				.select()
				.from(targzFiles)
				.where(and(eq(targzFiles.fileId, file.id), eq(targzFiles.path, listPath)));
		} else {
			index = await db.select().from(targzFiles).where(eq(targzFiles.fileId, file.id));
		}

		return c.json(index);
	}

	const fileQuery = c.req.query('file');
	if (file.isTargz && fileQuery && typeof fileQuery === 'string') {
		const indexEntry = await db
			.select()
			.from(targzFiles)
			.where(and(eq(targzFiles.fileId, file.id), eq(targzFiles.path, fileQuery)))
			.get();

		if (!indexEntry) {
			throw new HTTPException(404, { message: 'File not found in archive' });
		}

		try {
			const isSingleBlock = indexEntry.aFirstEnd === indexEntry.aFinalStart;

			// First block: [aStart, aFirstEnd)
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

			// Create combined stream
			const combinedStream = new ReadableStream<Uint8Array>({
				async start(controller) {
					// Send first block
					controller.enqueue(firstBgzfBlock);

					// Send intermediate blocks as-is (stream directly)
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

					// Send last block if multi-block
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

			return new Response(combinedStream, {
				headers: {
					'Content-Type': indexEntry.mimeType ?? 'application/octet-stream',
					'Content-Encoding': 'gzip',
					'Content-Disposition': getContentDisposition(indexEntry.path, acceptsGzip),
					'ETag': getETag(`"${file.id}-${indexEntry.path}"`, acceptsGzip),
				},
			});
		} catch (error) {
			console.error('Failed to fetch from R2:', error);
			throw new HTTPException(500, { message: 'Internal server error' });
		}
	}

	const r2Object = await c.env.R2.get(file.r2Key);

	if (!r2Object) {
		throw new HTTPException(404, { message: 'File not found in storage' });
	}

	return new Response(r2Object.body, {
		headers: {
			'Content-Type': file.mimeType ?? 'application/octet-stream',
			'Content-Length': String(file.size ?? 0),
		},
	});
});

app.delete('/d/:bucketName/*', authMiddleware, async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const bucketName = c.req.param('bucketName');
	const filePath = c.req.path.replace(`/d/${bucketName}/`, '');

	const bucket = await db.select().from(buckets).where(eq(buckets.name, bucketName)).get();

	if (!bucket) {
		throw new HTTPException(404, { message: 'Bucket not found' });
	}

	if (bucket.userId !== user.id && !user.isAdmin) {
		throw new HTTPException(403, { message: 'Forbidden' });
	}

	const file = await db
		.select()
		.from(files)
		.where(and(eq(files.bucketId, bucket.id), eq(files.path, filePath)))
		.get();

	if (!file) {
		throw new HTTPException(404, { message: 'File not found' });
	}

	try {
		await c.env.R2.delete(file.r2Key);
	} catch (error) {
		console.error('Failed to delete R2 object:', file.r2Key, error);
	}

	await db.delete(files).where(eq(files.id, file.id));

	return c.json({ ok: true });
});

export default app;
