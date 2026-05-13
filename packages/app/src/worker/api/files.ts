import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, gte, lte } from 'drizzle-orm';
import { buckets, files, targzFiles } from '../scheme/index';
import { getDb } from '../utils/db';
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
					aFinalStart: { type: 'integer' },
					aEnd: { type: 'integer' },
					rStartOffset: { type: 'integer' },
					rEndOffset: { type: 'integer' },
				},
				required: ['path', 'mimeType', 'aStart', 'aFinalStart', 'aEnd', 'rStartOffset', 'rEndOffset'],
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

const app = new Hono<{ Bindings: CloudflareBindings }>();

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

	const maxFilesStr = c.env.MAX_FILES_PER_BUCKET;
	if (maxFilesStr) {
		const maxFiles = parseInt(maxFilesStr, 10);
		if (!Number.isNaN(maxFiles)) {
			const fileCount = await db
				.select()
				.from(files)
				.where(eq(files.bucketId, bucket.id))
				.then((result) => result.length);

			if (fileCount >= maxFiles) {
				throw new HTTPException(429, { message: 'File limit exceeded' });
			}
		}
	}

	const maxUploadsStr = c.env.MAX_DAILY_UPLOADS;
	if (maxUploadsStr) {
		const maxUploads = parseInt(maxUploadsStr, 10);
		if (!Number.isNaN(maxUploads)) {
			const dayStart = Date.now() - 24 * 60 * 60 * 1000;
			const dailyUploadCount = await db
				.select()
				.from(files)
				.where(and(eq(files.bucketId, bucket.id), gte(files.createdAt, dayStart)))
				.then((result) => result.length);

			if (dailyUploadCount >= maxUploads) {
				throw new HTTPException(429, { message: 'Daily upload limit exceeded' });
			}
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
			aFinalStart: entry.aFinalStart,
			aEnd: entry.aEnd,
			rStartOffset: entry.rStartOffset,
			rEndOffset: entry.rEndOffset,
		});
	}

	await db.update(files).set({ isTargz: true }).where(eq(files.id, file.id));

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

	const r2Object = await c.env.R2.head(file.r2Key);

	if (!r2Object) {
		throw new HTTPException(400, { message: 'Upload has not been completed' });
	}

	const maxBucketSizeStr = c.env.MAX_BUCKET_SIZE_BYTES;
	if (maxBucketSizeStr) {
		const maxBucketSize = parseInt(maxBucketSizeStr, 10);
		if (!Number.isNaN(maxBucketSize)) {
			const bucketFiles = await db.select().from(files).where(eq(files.bucketId, bucket.id));
			const totalSize = bucketFiles.reduce((sum, f) => sum + (f.size ?? 0), 0) + (r2Object.size ?? 0);

			if (totalSize > maxBucketSize) {
				throw new HTTPException(429, { message: 'Bucket size limit exceeded' });
			}
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
