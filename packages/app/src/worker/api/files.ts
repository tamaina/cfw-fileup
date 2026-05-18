import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, and, gte, desc, sql, count } from 'drizzle-orm';
import { fileTypeFromStream } from 'file-type';
import { buckets, files, targzFiles, tarFiles, uploadParts, DEFAULT_PART_SIZE, MIN_PART_SIZE } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser } from '../utils/rate-limit';
import { authMiddleware } from '../middleware/auth';
import { genEaidx } from '../../shared/eaid-x';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

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
		const r2Key = `${bucket.id}/${body.path}`;
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

		const r2Object = await c.env.R2.head(file.r2Key);

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
				if (r2Slice?.body) {
					const result = await fileTypeFromStream(r2Slice.body as ReadableStream<Uint8Array>);
					detectedMimeType = result?.mime;
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
				isPublic: body.isPublic,
				passphrase: body.passphrase,
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

		await db
			.update(files)
			.set({
				isPublic: body.isPublic,
				passphrase: body.isPublic ? null : (body.passphrase ?? null),
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
				isPublic: files.isPublic,
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

		if (!body.bucketId || !body.path) {
			throw new HTTPException(400, { message: 'bucketId and path are required' });
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, body.bucketId)).get();

		if (!bucket) {
			throw new HTTPException(404, { message: 'Bucket not found' });
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw new HTTPException(403, { message: 'Forbidden' });
		}

		const file = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, bucket.id), eq(files.path, body.path)))
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

		if (file.isClosed && file.size) {
			await db
				.update(buckets)
				.set({ usedBytes: sql`MAX(0, ${buckets.usedBytes} - ${file.size})` })
				.where(eq(buckets.id, bucket.id));
		}

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/delete')),
);

export const fileRoutes = app;
