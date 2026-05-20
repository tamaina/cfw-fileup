import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, and, gte, desc, sql, count, like } from 'drizzle-orm';
import { filetypemime } from 'magic-bytes.js';
import { buckets, files, targzFiles, tarFiles, uploadParts, directories, tokens, users, DEFAULT_PART_SIZE, MIN_PART_SIZE } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser } from '../utils/rate-limit';
import { authMiddleware } from '../middleware/auth';
import { genEaidx } from '../../shared/eaid-x';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';

const app = new Hono<{ Bindings: Env }>();

async function listFiles(c: { env: Env; req: { header(name: string): string | undefined } }, bucketName: string, path = '', forceOwner = false) {
	const db = getDb(c.env);
	const normalizedPath = path === '' || path.endsWith('/') ? path : `${path}/`;
	const bucket = await db.select().from(buckets).where(eq(buckets.name, bucketName)).get();
	if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });

	let isOwnerOrAdmin = forceOwner;
	if (!isOwnerOrAdmin) {
		const authorization = c.req.header('Authorization');
		if (authorization?.startsWith('Bearer ')) {
			const token = authorization.slice(7);
			const tokenRecord = await db
				.select({ userId: tokens.userId, isAdmin: users.isAdmin, isSuspended: users.isSuspended })
				.from(tokens)
				.innerJoin(users, eq(tokens.userId, users.id))
				.where(eq(tokens.token, token))
				.get();
			isOwnerOrAdmin = !!tokenRecord && !tokenRecord.isSuspended && (tokenRecord.isAdmin || tokenRecord.userId === bucket.userId);
		}
	}

	if (normalizedPath !== '') {
		const dirExists = await db.select({ id: directories.id })
			.from(directories)
			.where(and(eq(directories.bucketId, bucket.id), eq(directories.path, normalizedPath)))
			.get();
		if (!dirExists) {
			const hasFileCondition = isOwnerOrAdmin
				? and(eq(files.bucketId, bucket.id), like(files.path, `${normalizedPath}%`), eq(files.isClosed, true))
				: and(eq(files.bucketId, bucket.id), like(files.path, `${normalizedPath}%`), eq(files.isClosed, true), eq(files.visibility, 'public'));
			const hasFile = await db.select({ path: files.path }).from(files).where(hasFileCondition).get();
			if (!hasFile) throw new HTTPException(404, { message: 'Directory not found' });
		}
	}

	const fileCondition = isOwnerOrAdmin
		? and(eq(files.bucketId, bucket.id), eq(files.isClosed, true))
		: and(eq(files.bucketId, bucket.id), eq(files.isClosed, true), eq(files.visibility, 'public'));
	const allFiles = await db
		.select({
			id: files.id,
			path: files.path,
			size: files.size,
			mimeType: files.mimeType,
			isTargz: files.isTargz,
			isTar: files.isTar,
			visibility: files.visibility,
		})
		.from(files)
		.where(fileCondition);
	const allDirs = await db.select({ path: directories.path }).from(directories).where(eq(directories.bucketId, bucket.id));

	const entries: Array<{ type: 'dir' | 'file'; name: string; path?: string; fileId?: string; size?: number; mimeType?: string; isTargz?: boolean; isTar?: boolean; visibility?: 'public' | 'private' | 'passphrase' }> = [];
	const seenDirs = new Set<string>();
	for (const d of allDirs) {
		if (!d.path.startsWith(normalizedPath)) continue;
		const rest = d.path.slice(normalizedPath.length);
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
		if (!f.path.startsWith(normalizedPath)) continue;
		const rest = f.path.slice(normalizedPath.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx === -1) {
			entries.push({ type: 'file', name: rest, path: f.path, fileId: f.id, size: f.size ?? undefined, mimeType: f.mimeType ?? undefined, isTargz: f.isTargz, isTar: f.isTar, visibility: f.visibility });
		} else {
			const dirName = rest.slice(0, slashIdx);
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				entries.push({ type: 'dir', name: dirName });
			}
		}
	}
	entries.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
	return { type: 'directory' as const, entries };
}

app.get('/ls', async (c) => {
	const bucketName = c.req.query('bucketName');
	if (!bucketName) throw new HTTPException(400, { message: 'bucketName is required' });
	return c.json(await listFiles(c, bucketName, c.req.query('path') ?? ''), 200);
});

app.get('/meta', async (c) => {
	const bucketName = c.req.query('bucketName');
	const path = c.req.query('path');
	if (!bucketName || path == null) throw new HTTPException(400, { message: 'bucketName and path are required' });

	const db = getDb(c.env);
	const bucket = await db.select().from(buckets).where(eq(buckets.name, bucketName)).get();
	if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });

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

	const file = await db
		.select()
		.from(files)
		.where(and(eq(files.bucketId, bucket.id), eq(files.path, path), eq(files.isClosed, true)))
		.get();
	if (!file) throw new HTTPException(404, { message: 'File not found' });

	const base = { visibility: file.visibility, isTargz: file.isTargz, isTar: file.isTar, size: file.size };
	if (file.visibility === 'public' || isOwnerOrAdmin) {
		return c.json({ ...base, fileId: file.id, bucketId: bucket.id });
	}
	return c.json(base);
});

app.use(authMiddleware);

app.post(
	'/ls',
	describeRoute(omitResAndReq(apiDef['/api/files/ls'])),
	validator('json', apiDef['/api/files/ls'].req),
	describeResponse(async (c: JsonCtx<'/api/files/ls', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const bucket = await db.select().from(buckets).where(eq(buckets.name, body.bucketName)).get();
		if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });
		if (bucket.userId !== user.id && !user.isAdmin) throw new HTTPException(403, { message: 'Forbidden' });
		return c.json(await listFiles(c, body.bucketName, body.path ?? '', true), 200);
	}, getResponseDefWithAuth('/api/files/ls')),
);

app.post(
	'/create/open',
	describeRoute(omitResAndReq(apiDef['/api/files/create/open'])),
	validator('json', apiDef['/api/files/create/open'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/open', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.bucketId || !body.path) {
			throw new HTTPException(400, { message: 'bucketId and path are required' });
		}

		const partSize = body.partSize ?? DEFAULT_PART_SIZE;
		if (partSize < MIN_PART_SIZE) {
			throw new HTTPException(400, { message: `partSize must be at least ${MIN_PART_SIZE} bytes (5 MiB)` });
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, body.bucketId)).get();

		if (!bucket) {
			throw new HTTPException(404, { message: 'Bucket not found' });
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw new HTTPException(403, { message: 'Forbidden' });
		}

		const existingFile = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, bucket.id), eq(files.path, body.path)))
			.get();

		if (existingFile && existingFile.isClosed) {
			throw new HTTPException(409, { message: 'File already exists' });
		}

		const quota = await getQuotaForUser(c.env, user.id);

		if (quota.maxFilesPerBucket !== null) {
			const fileCount = await db
				.select()
				.from(files)
				.where(eq(files.bucketId, bucket.id))
				.then((result) => result.length);

			if (fileCount >= quota.maxFilesPerBucket) {
				throw new HTTPException(429, { message: 'File limit exceeded' });
			}
		}

		if (quota.maxDailyUploads !== null) {
			const dayStart = Date.now() - 24 * 60 * 60 * 1000;
			const dailyUploadCount = await db
				.select()
				.from(files)
				.where(and(eq(files.userId, user.id), gte(files.id, genEaidx(dayStart))))
				.then((result) => result.length);

			if (dailyUploadCount >= quota.maxDailyUploads) {
				throw new HTTPException(429, { message: 'Daily upload limit exceeded' });
			}
		}

		const fileId = genEaidx(Date.now());
		const r2Key = fileId;
		const uploadExpiry = Date.now() + 24 * 60 * 60 * 1000;

		await db.insert(files).values({
			id: fileId,
			bucketId: bucket.id,
			userId: user.id,
			path: body.path,
			r2Key,
			uploadExpiresAt: uploadExpiry,
			partSize,
		});

		return c.json({ fileId, uploadExpiry, partSize }, 200);
	}, getResponseDefWithAuth('/api/files/create/open')),
);

app.post(
	'/create/targz-index',
	describeRoute(omitResAndReq(apiDef['/api/files/create/targz-index'])),
	validator('json', apiDef['/api/files/create/targz-index'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/targz-index', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.fileId || !body.files) {
			throw new HTTPException(400, { message: 'fileId and files are required' });
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();

		if (!file) {
			throw new HTTPException(404, { message: 'File not found' });
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();

		if (!bucket) {
			throw new HTTPException(404, { message: 'Bucket not found' });
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw new HTTPException(403, { message: 'Forbidden' });
		}

		if (file.uploadExpiresAt < Date.now()) {
			throw new HTTPException(410, { message: 'Upload expired' });
		}

		const fileIds = body.files.map(() => genEaidx(Date.now()));

		for (let i = 0; i < body.files.length; i++) {
			const entry = body.files[i];
			await db.insert(targzFiles).values({
				id: fileIds[i],
				fileId: file.id,
				path: entry.path,
				mimeType: entry.mimeType,
				aStart: entry.aStart,
				aFirstEnd: entry.aFirstEnd,
				aFinalStart: entry.aFinalStart,
				aEnd: entry.aEnd,
				rStartOffset: entry.rStartOffset,
				rEndOffset: entry.rEndOffset,
			});
		}

		await db.update(files).set({ isTargz: true }).where(eq(files.id, file.id));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/create/targz-index')),
);

app.post(
	'/create/tar-index',
	describeRoute(omitResAndReq(apiDef['/api/files/create/tar-index'])),
	validator('json', apiDef['/api/files/create/tar-index'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/tar-index', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.fileId || !body.files) {
			throw new HTTPException(400, { message: 'fileId and files are required' });
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();
		if (!file) throw new HTTPException(404, { message: 'File not found' });

		const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();
		if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });
		if (bucket.userId !== user.id && !user.isAdmin) throw new HTTPException(403, { message: 'Forbidden' });
		if (file.uploadExpiresAt < Date.now()) throw new HTTPException(410, { message: 'Upload expired' });

		const fileIds = body.files.map(() => genEaidx(Date.now()));
		for (let i = 0; i < body.files.length; i++) {
			const entry = body.files[i];
			await db.insert(tarFiles).values({
				id: fileIds[i],
				fileId: file.id,
				path: entry.path,
				mimeType: entry.mimeType,
				offset: entry.offset,
				size: entry.size,
			});
		}

		await db.update(files).set({ isTar: true }).where(eq(files.id, file.id));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/create/tar-index')),
);

app.post(
	'/create/close',
	describeRoute(omitResAndReq(apiDef['/api/files/create/close'])),
	validator('json', apiDef['/api/files/create/close'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/close', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.fileId) {
			throw new HTTPException(400, { message: 'fileId is required' });
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();

		if (!file) {
			throw new HTTPException(404, { message: 'File not found' });
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();

		if (!bucket) {
			throw new HTTPException(404, { message: 'Bucket not found' });
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw new HTTPException(403, { message: 'Forbidden' });
		}

		if (file.uploadExpiresAt < Date.now()) {
			throw new HTTPException(410, { message: 'Upload expired' });
		}

		const quota = await getQuotaForUser(c.env, user.id);

		if (file.uploadId) {
			const parts = await db
				.select()
				.from(uploadParts)
				.where(eq(uploadParts.fileId, file.id));

			if (parts.length === 0) {
				throw new HTTPException(400, { message: 'Upload has not been completed' });
			}

			const sortedParts = parts
				.slice()
				.sort((a, b) => a.partNumber - b.partNumber)
				.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));

			const multipartUpload = c.env.R2.resumeMultipartUpload(file.r2Key, file.uploadId);
			try {
				await multipartUpload.complete(sortedParts);
			} catch (err) {
				console.error('Failed to complete multipart upload:', err);
				throw new HTTPException(400, { message: 'Failed to finalize upload' });
			}

			await db.update(files).set({ uploadId: null }).where(eq(files.id, file.id));
		}

		let r2Object = await c.env.R2.head(file.r2Key);
		if (!r2Object) {
			const legacyR2Key = `${bucket.id}/${file.path}`;
			r2Object = await c.env.R2.head(legacyR2Key);
			if (r2Object) {
				await db.update(files).set({ r2Key: legacyR2Key }).where(eq(files.id, file.id));
				file.r2Key = legacyR2Key;
			}
		}

		if (!r2Object) {
			throw new HTTPException(400, { message: 'Upload has not been completed' });
		}

		if (quota.maxBucketSizeBytes !== null) {
			if (bucket.usedBytes + r2Object.size > quota.maxBucketSizeBytes) {
				throw new HTTPException(429, { message: 'Bucket size limit exceeded' });
			}
		}

		const fileSize = r2Object.size;

		let detectedMimeType: string | undefined;
		if (fileSize > 0) {
			try {
				const r2Slice = await c.env.R2.get(file.r2Key, { range: { offset: 0, length: 4100 } });
				if (r2Slice && 'bytes' in r2Slice) {
          await r2Slice.bytes().then(bytes => {
					detectedMimeType = filetypemime(bytes)[0];
          });
				}
			} catch {
				// fall back to client-provided content type
			}
		}
		const mimeType = detectedMimeType ?? r2Object.httpMetadata?.contentType;

		await db
			.update(files)
			.set({
				isClosed: true,
				visibility: body.visibility,
				passphrase: body.visibility === 'passphrase' ? (body.passphrase ?? null) : null,
				size: fileSize,
				mimeType,
			})
			.where(eq(files.id, file.id));

		await db
			.update(buckets)
			.set({ usedBytes: sql`${buckets.usedBytes} + ${fileSize}` })
			.where(eq(buckets.id, bucket.id));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/create/close')),
);

app.post(
	'/create/status',
	describeRoute(omitResAndReq(apiDef['/api/files/create/status'])),
	validator('json', apiDef['/api/files/create/status'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/status', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body?.fileId) {
			throw new HTTPException(400, { message: 'fileId is required' });
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();

		if (!file) {
			throw new HTTPException(404, { message: 'File not found' });
		}

		if (file.userId !== user.id && !user.isAdmin) {
			throw new HTTPException(403, { message: 'Forbidden' });
		}

		const [{ partCount }] = await db
			.select({ partCount: count() })
			.from(uploadParts)
			.where(eq(uploadParts.fileId, file.id));

		const partSize = file.partSize;
		return c.json({ partCount, offset: partCount * partSize, partSize }, 200);
	}, getResponseDefWithAuth('/api/files/create/status')),
);

app.post(
	'/update',
	describeRoute(omitResAndReq(apiDef['/api/files/update'])),
	validator('json', apiDef['/api/files/update'].req),
	describeResponse(async (c: JsonCtx<'/api/files/update', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.bucketName || !body.filePath) {
			throw new HTTPException(400, { message: 'bucketName and filePath are required' });
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.name, body.bucketName)).get();
		if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });
		if (bucket.userId !== user.id && !user.isAdmin) throw new HTTPException(403, { message: 'Forbidden' });

		const file = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, bucket.id), eq(files.path, body.filePath)))
			.get();
		if (!file) throw new HTTPException(404, { message: 'File not found' });
		if (!file.isClosed) throw new HTTPException(400, { message: 'File is not closed' });
		if (file.visibility === 'public' && body.visibility !== 'public') {
			throw new HTTPException(400, { message: 'Public files cannot change visibility' });
		}

		await db
			.update(files)
			.set({
				visibility: body.visibility,
				passphrase: body.visibility === 'passphrase' ? (body.passphrase ?? null) : null,
			})
			.where(eq(files.id, file.id));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/update')),
);

app.post(
	'/uploadings',
	describeRoute(omitResAndReq(apiDef['/api/files/uploadings'])),
	validator('json', apiDef['/api/files/uploadings'].req),
	describeResponse(async (c: JsonCtx<'/api/files/uploadings', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');

		const userFiles = await db
			.select({
				id: files.id,
				bucketId: files.bucketId,
				bucketName: buckets.name,
				path: files.path,
				size: files.size,
				isClosed: files.isClosed,
				visibility: files.visibility,
				uploadExpiresAt: files.uploadExpiresAt,
				isTargz: files.isTargz,
				isTar: files.isTar,
			})
			.from(files)
			.innerJoin(buckets, eq(files.bucketId, buckets.id))
			.where(eq(files.userId, user.id))
			.orderBy(desc(files.id));

		return c.json({ files: userFiles }, 200);
	}, getResponseDefWithAuth('/api/files/uploadings')),
);

app.post(
	'/delete',
	describeRoute(omitResAndReq(apiDef['/api/files/delete'])),
	validator('json', apiDef['/api/files/delete'].req),
	describeResponse(async (c: JsonCtx<'/api/files/delete', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.bucketId) {
			throw new HTTPException(400, { message: 'bucketId is required' });
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, body.bucketId)).get();

		if (!bucket) {
			throw new HTTPException(404, { message: 'Bucket not found' });
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw new HTTPException(403, { message: 'Forbidden' });
		}

		const targets = body.targets ?? (body.path ? [{ type: 'file' as const, path: body.path }] : []);
		if (targets.length === 0) {
			throw new HTTPException(400, { message: 'path or targets are required' });
		}

		const filesToDelete = new Map<string, {
			id: string;
			r2Key: string;
			isClosed: boolean;
			size: number | null;
		}>();
		const directoryPrefixes = new Set<string>();

		for (const target of targets) {
			if (target.type === 'file') {
				const file = await db
					.select()
					.from(files)
					.where(and(eq(files.bucketId, bucket.id), eq(files.path, target.path)))
					.get();
				if (!file) throw new HTTPException(404, { message: `File not found: ${target.path}` });
				filesToDelete.set(file.id, file);
				continue;
			}

			const prefix = target.path === '' ? '' : target.path.endsWith('/') ? target.path : `${target.path}/`;
			const excludePaths = target.excludePaths ?? [];
			const childFiles = await db
				.select({ id: files.id, r2Key: files.r2Key, isClosed: files.isClosed, size: files.size, path: files.path })
				.from(files)
				.where(and(eq(files.bucketId, bucket.id), like(files.path, `${prefix}%`)));

			for (const file of childFiles) {
				if (excludePaths.some((excludePath) => {
					if (excludePath.endsWith('/')) return file.path.startsWith(excludePath);
					return file.path === excludePath;
				})) continue;
				filesToDelete.set(file.id, file);
			}

			if (excludePaths.length === 0) {
				directoryPrefixes.add(prefix);
			}
			const childDirectories = await db
				.select({ path: directories.path })
				.from(directories)
				.where(and(eq(directories.bucketId, bucket.id), like(directories.path, `${prefix}%`)));
			for (const dir of childDirectories) {
				if (excludePaths.some((excludePath) => {
					const normalizedExcludePath = excludePath.endsWith('/') ? excludePath : `${excludePath}/`;
					return dir.path === normalizedExcludePath || dir.path.startsWith(normalizedExcludePath) || normalizedExcludePath.startsWith(dir.path);
				})) continue;
				directoryPrefixes.add(dir.path);
			}
		}

		for (const file of filesToDelete.values()) {
			try {
				await c.env.R2.delete(file.r2Key);
			} catch (error) {
				console.error('Failed to delete R2 object:', file.r2Key, error);
			}
		}

		for (const file of filesToDelete.values()) {
			await db.delete(files).where(eq(files.id, file.id));
		}

		const sizeToDecrement = Array.from(filesToDelete.values()).reduce((sum, file) => sum + (file.isClosed && file.size ? file.size : 0), 0);
		if (sizeToDecrement > 0) {
			await db
				.update(buckets)
				.set({ usedBytes: sql`MAX(0, ${buckets.usedBytes} - ${sizeToDecrement})` })
				.where(eq(buckets.id, bucket.id));
		}

		for (const prefix of directoryPrefixes) {
			await db.delete(directories).where(and(eq(directories.bucketId, bucket.id), like(directories.path, `${prefix}%`)));
		}

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/delete')),
);

export const fileRoutes = app;
