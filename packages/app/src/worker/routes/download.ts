import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, like, sql } from 'drizzle-orm';
import { createBgzfBlock } from 'bgzf';
import { buckets, files, targzFiles, tarFiles, directories, tokens, users, fileAccessTokens } from '../scheme/index';
import { getDb } from '../utils/db';
import { abortUpload } from '../utils/abort-upload';
import { authMiddleware } from '../middleware/auth';

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

app.get('/d/:bucketName/*', async (c) => {
	const db = getDb(c.env);
	const bucketName = c.req.param('bucketName');
	const filePath = c.req.path.replace(`/d/${bucketName}/`, '');
	const acceptEncoding = c.req.header('Accept-Encoding') ?? '';
	const acceptsGzip = acceptEncoding.includes('gzip');

	const bucket = await db.select().from(buckets).where(eq(buckets.name, bucketName)).get();

	if (!bucket) {
		throw new HTTPException(404, { message: 'Bucket not found' });
	}

	const isDirectory = filePath === '' || filePath.endsWith('/');

	if (isDirectory) {
		// Check if requester is bucket owner or admin to show non-public files
		let isOwnerOrAdmin = false;
		const authorization = c.req.header('Authorization');
		if (authorization?.startsWith('Bearer ')) {
			const token = authorization.slice(7);
			const tokenRecord = await db
				.select({ userId: tokens.userId, isAdmin: users.isAdmin, isSuspended: users.isSuspended })
				.from(tokens)
				.innerJoin(users, eq(tokens.userId, users.id))
				.where(eq(tokens.token, token))
				.get();
			if (tokenRecord && !tokenRecord.isSuspended) {
				isOwnerOrAdmin = tokenRecord.isAdmin || tokenRecord.userId === bucket.userId;
			}
		}

		if (filePath !== '') {
			const dirExists = await db.select({ id: directories.id })
				.from(directories)
				.where(and(eq(directories.bucketId, bucket.id), eq(directories.path, filePath)))
				.get();
			if (!dirExists) {
				const hasFile = await db.select({ path: files.path })
					.from(files)
					.where(and(eq(files.bucketId, bucket.id), like(files.path, `${filePath}%`)))
					.get();
				if (!hasFile) throw new HTTPException(404, { message: 'Directory not found' });
			}
		}

		const fileCondition = isOwnerOrAdmin
			? and(eq(files.bucketId, bucket.id), eq(files.isClosed, true))
			: and(eq(files.bucketId, bucket.id), eq(files.isClosed, true), eq(files.isPublic, true));

		const allFiles = await db
			.select({
				path: files.path,
				size: files.size,
				mimeType: files.mimeType,
				isTargz: files.isTargz,
				isTar: files.isTar,
				isPublic: files.isPublic,
			})
			.from(files)
			.where(fileCondition);

		const entries: Array<{
			type: 'dir' | 'file';
			name: string;
			path?: string;
			size?: number;
			mimeType?: string;
			isTargz?: boolean;
			isTar?: boolean;
			isPublic?: boolean;
		}> = [];
		const seenDirs = new Set<string>();

		const allDirs = await db
			.select({ path: directories.path })
			.from(directories)
			.where(eq(directories.bucketId, bucket.id));

		for (const d of allDirs) {
			if (!d.path.startsWith(filePath)) continue;
			const rest = d.path.slice(filePath.length);
			const slashIdx = rest.indexOf('/');
			if (slashIdx !== -1) {
				const dirName = rest.slice(0, slashIdx);
				if (!seenDirs.has(dirName)) {
					seenDirs.add(dirName);
					entries.push({ type: 'dir', name: dirName });
				}
			}
		}

		for (const f of allFiles) {
			if (!f.path.startsWith(filePath)) continue;
			const rest = f.path.slice(filePath.length);
			const slashIdx = rest.indexOf('/');
			if (slashIdx === -1) {
				entries.push({ type: 'file', name: rest, path: f.path, size: f.size ?? undefined, mimeType: f.mimeType ?? undefined, isTargz: f.isTargz, isTar: f.isTar, isPublic: f.isPublic });
			} else {
				const dirName = rest.slice(0, slashIdx);
				if (!seenDirs.has(dirName)) {
					seenDirs.add(dirName);
					entries.push({ type: 'dir', name: dirName });
				}
			}
		}

		entries.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return c.json({ type: 'directory', entries });
	}

	const file = await db
		.select()
		.from(files)
		.where(and(eq(files.bucketId, bucket.id), eq(files.path, filePath)))
		.get();

	if (!file) {
		throw new HTTPException(404, { message: 'File not found' });
	}

	if (c.req.query('meta') !== undefined) {
		return c.json({
			type: 'file',
			path: file.path,
			size: file.size,
			mimeType: file.mimeType,
			isTargz: file.isTargz,
			isTar: file.isTar,
			isPublic: file.isPublic,
		});
	}

	if (!file.isPublic) {
		const passphrase = c.req.query('passphrase');
		const fileToken = c.req.query('token');

		if (passphrase && passphrase === file.passphrase) {
			// passphrase OK
		} else if (fileToken) {
			const fileTokenRecord = await db
				.select()
				.from(fileAccessTokens)
				.where(and(eq(fileAccessTokens.token, fileToken), eq(fileAccessTokens.fileId, file.id)))
				.get();
			if (!fileTokenRecord || (fileTokenRecord.expiresAt !== null && fileTokenRecord.expiresAt < Date.now())) {
				throw new HTTPException(403, { message: 'Forbidden' });
			}
		} else {
			const authorization = c.req.header('Authorization');
			if (!authorization?.startsWith('Bearer ')) {
				throw new HTTPException(403, { message: 'Forbidden' });
			}
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

	if ((file.isTargz || file.isTar) && c.req.query('list') !== undefined) {
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

	const fileQuery = c.req.query('file');
	if (file.isTar && fileQuery && typeof fileQuery === 'string') {
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

		return new Response(rangeData.body, {
			headers: {
				'Content-Type': indexEntry.mimeType,
				'Content-Disposition': `attachment; filename="${indexEntry.path.split('/').pop()}"`,
				'Content-Length': String(indexEntry.size),
			},
		});
	}

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
			const isSingleBlock = indexEntry.aStart === indexEntry.aFinalStart;

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
					'Content-Type': indexEntry.mimeType,
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

	await abortUpload(file, c.env);

	if (file.isClosed && file.size) {
		await db
			.update(buckets)
			.set({ usedBytes: sql`MAX(0, ${buckets.usedBytes} - ${file.size})` })
			.where(eq(buckets.id, bucket.id));
	}

	return c.json({ ok: true });
});

export const downloadRoutes = app;
