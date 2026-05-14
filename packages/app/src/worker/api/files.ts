import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, gte } from 'drizzle-orm';
import { buckets, files, targzFiles, tarFiles, uploadParts } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser } from '../utils/rate-limit';
import { authMiddleware } from '../middleware/auth';
import { genEaidx } from '../../shared/eaid-x';
import type { Schema, SchemaType } from './schema-type';

const createOpenSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
		path: { type: 'string' },
	},
	required: ['bucketId', 'path'],
} as const satisfies Schema;

const targzIndexSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
		files: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					mimeType: { type: 'string' },
					aStart: { type: 'integer' },
					aFirstEnd: { type: 'integer' },
					aFinalStart: { type: 'integer' },
					aEnd: { type: 'integer' },
					rStartOffset: { type: 'integer' },
					rEndOffset: { type: 'integer' },
				},
				required: ['path', 'mimeType', 'aStart', 'aFirstEnd', 'aFinalStart', 'aEnd', 'rStartOffset', 'rEndOffset'],
			},
		},
	},
	required: ['fileId', 'files'],
} as const satisfies Schema;

const tarIndexSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
		files: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					mimeType: { type: 'string' },
					offset: { type: 'integer' },
					size: { type: 'integer' },
				},
				required: ['path', 'mimeType', 'offset', 'size'],
			},
		},
	},
	required: ['fileId', 'files'],
} as const satisfies Schema;

const createCloseSchema = {
	type: 'object',
	properties: {
		fileId: { type: 'string' },
		isPublic: { type: 'boolean' },
		passphrase: { type: 'string', optional: true },
	},
	required: ['fileId', 'isPublic'],
} as const satisfies Schema;

const deleteFileSchema = {
	type: 'object',
	properties: {
		bucketId: { type: 'string' },
		path: { type: 'string' },
	},
	required: ['bucketId', 'path'],
} as const satisfies Schema;

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

app.post('/create/open', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const body = (await c.req.json()) as SchemaType<typeof createOpenSchema>;

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
			.where(and(eq(files.bucketId, bucket.id), gte(files.createdAt, dayStart)))
			.then((result) => result.length);

		if (dailyUploadCount >= quota.maxDailyUploads) {
			throw new HTTPException(429, { message: 'Daily upload limit exceeded' });
		}
	}

	const fileId = genEaidx(Date.now());
	const r2Key = `${bucket.id}/${body.path}`;
	const now = Date.now();
	const uploadExpiry = now + 24 * 60 * 60 * 1000;

	await db.insert(files).values({
		id: fileId,
		bucketId: bucket.id,
		path: body.path,
		r2Key,
		uploadExpiresAt: uploadExpiry,
		createdAt: now,
	});

	return c.json({ fileId, uploadExpiry });
});

app.post('/create/targz-index', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const body = (await c.req.json()) as unknown;

	const typedBody = body as SchemaType<typeof targzIndexSchema>;

	if (!typedBody.fileId || !typedBody.files) {
		throw new HTTPException(400, { message: 'fileId and files are required' });
	}

	const file = await db.select().from(files).where(eq(files.id, typedBody.fileId)).get();

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

	const fileIds = typedBody.files.map(() => genEaidx(Date.now()));

	for (let i = 0; i < typedBody.files.length; i++) {
		const entry = typedBody.files[i];
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

	return c.json({ ok: true });
});

app.post('/create/tar-index', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const body = (await c.req.json()) as SchemaType<typeof tarIndexSchema>;

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

	return c.json({ ok: true });
});

app.post('/create/close', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const body = (await c.req.json()) as SchemaType<typeof createCloseSchema>;

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

	// Finalize R2 multipart upload if one is in progress
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
		const bucketFiles = await db.select().from(files).where(eq(files.bucketId, bucket.id));
		const totalSize = bucketFiles.reduce((sum, f) => sum + (f.size ?? 0), 0) + (r2Object.size ?? 0);

		if (totalSize > quota.maxBucketSizeBytes) {
			throw new HTTPException(429, { message: 'Bucket size limit exceeded' });
		}
	}

	await db
		.update(files)
		.set({
			isClosed: true,
			isPublic: body.isPublic ?? true,
			passphrase: body.passphrase ?? null,
			size: r2Object.size ?? 0,
			mimeType: r2Object.httpMetadata?.contentType,
		})
		.where(eq(files.id, file.id));

	return c.json({ ok: true });
});

app.post('/delete', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const body = (await c.req.json()) as SchemaType<typeof deleteFileSchema>;

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

	return c.json({ ok: true });
});

export default app;
