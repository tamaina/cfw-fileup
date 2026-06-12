import { Hono } from 'hono';
import { eq, max, sql } from 'drizzle-orm';
import { buckets, DEFAULT_PART_SIZE, files, uploadParts } from '../scheme/index';
import { getDb } from '../utils/db';
import { abortUpload } from '../utils/abort-upload';
import { authMiddleware } from '../middleware/auth';
import { genEaidx } from '../../shared/eaid-x';
import { apiError } from '../utils/api-error';
import { getQuotaForUser } from '../utils/rate-limit';

const app = new Hono<{ Bindings: Env }>();

app.use('/upload/*', authMiddleware);

// Do not remove this plain PUT upload path. Files smaller than DEFAULT_PART_SIZE
// intentionally avoid R2 multipart/TUS resume to reduce Class A operations and upload overhead.
app.put('/upload/:fileId', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const fileId = c.req.param('fileId');

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();

	if (!file) {
		throw apiError(404, 'FILE_NOT_FOUND');
	}

	if (file.userId !== user.id && !user.isAdmin) {
		throw apiError(403, 'FORBIDDEN');
	}

	if (file.uploadExpiresAt < Date.now()) {
		await abortUpload(file, c.env);
		throw apiError(410, 'UPLOAD_EXPIRED');
	}

	if (file.uploadId) {
		throw apiError(400, 'INVALID_UPLOAD_OFFSET_HEADER');
	}

	const existingObject = await c.env.R2.head(file.r2Key);
	if (existingObject) {
		throw apiError(409, 'FILE_ALREADY_EXISTS');
	}

	const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
	if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
		throw apiError(400, 'INVALID_UPLOAD_OFFSET_HEADER');
	}
	if (contentLength >= DEFAULT_PART_SIZE) {
		throw apiError(400, 'INVALID_UPLOAD_OFFSET_HEADER', `non-resume upload must be smaller than ${DEFAULT_PART_SIZE} bytes`);
	}

	const [bucket, quota] = await Promise.all([
		db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get(),
		getQuotaForUser(c.env, file.userId),
	]);
	if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
	if (quota.maxBucketSizeBytes !== null && bucket.usedBytes + contentLength > quota.maxBucketSizeBytes) {
		throw apiError(429, 'BUCKET_LIMIT_EXCEEDED');
	}

	await c.env.R2.put(file.r2Key, c.req.raw.body ?? new Uint8Array(0), {
		httpMetadata: {
			contentType: c.req.header('Content-Type') ?? undefined,
		},
	});

	return new Response(null, { status: 204 });
});

app.get('/upload/:fileId/resume', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const fileId = c.req.param('fileId');

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();

	if (!file) {
		throw apiError(404, 'FILE_NOT_FOUND');
	}

	if (file.userId !== user.id && !user.isAdmin) {
		throw apiError(403, 'FORBIDDEN');
	}

	if (file.uploadExpiresAt < Date.now()) {
		await abortUpload(file, c.env);
		throw apiError(410, 'UPLOAD_EXPIRED');
	}

	let offset: number;
	if (file.uploadId) {
		const [{ count }] = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(uploadParts)
			.where(eq(uploadParts.fileId, fileId));
		// パートサイズはDBに保存した値を使用（クライアントが宣言したサイズに基づく）
		offset = Number(count) * file.partSize;
	} else {
		const r2Object = await c.env.R2.head(file.r2Key);
		offset = r2Object?.size ?? 0;
	}

	return new Response(null, {
		status: 200,
		headers: {
			'Upload-Offset': String(offset),
			'Tus-Resumable': '1.0.0',
		},
	});
});

app.patch('/upload/:fileId/resume', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const fileId = c.req.param('fileId');
	const uploadOffset = c.req.header('Upload-Offset');
	if (!uploadOffset) {
		throw apiError(400, 'UPLOAD_OFFSET_HEADER_IS_REQUIRED');
	}

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();

	if (!file) {
		throw apiError(404, 'FILE_NOT_FOUND');
	}

	if (file.userId !== user.id && !user.isAdmin) {
		throw apiError(403, 'FORBIDDEN');
	}

	if (file.uploadExpiresAt < Date.now()) {
		await abortUpload(file, c.env);
		throw apiError(410, 'UPLOAD_EXPIRED');
	}

	const currentOffset = parseInt(uploadOffset, 10);
	if (Number.isNaN(currentOffset)) {
		throw apiError(400, 'INVALID_UPLOAD_OFFSET_HEADER');
	}

	const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
	if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
		throw apiError(400, 'INVALID_UPLOAD_OFFSET_HEADER');
	}

	if (currentOffset === 0 && !file.uploadId) {
		const multipartUpload = await c.env.R2.createMultipartUpload(file.r2Key);
		await db.update(files).set({ uploadId: multipartUpload.uploadId }).where(eq(files.id, fileId));
		file.uploadId = multipartUpload.uploadId;
	}

	if (!file.uploadId) {
		throw apiError(400, 'UPLOAD_SESSION_NOT_INITIALIZED');
	}

	const [{ maxPartNumber }] = await db
		.select({ maxPartNumber: max(uploadParts.partNumber) })
		.from(uploadParts)
		.where(eq(uploadParts.fileId, fileId));
	const expectedOffset = (maxPartNumber ?? 0) * file.partSize;
	if (currentOffset !== expectedOffset) {
		throw apiError(409, 'INVALID_UPLOAD_OFFSET_HEADER', `Expected Upload-Offset ${expectedOffset}`);
	}

	// ファイル作成時にクライアントが宣言したパートサイズをDBから取得して検証
	if (contentLength > file.partSize) {
		throw apiError(400, 'INVALID_UPLOAD_OFFSET_HEADER', `All parts except the last must be at most ${file.partSize} bytes`);
	}

	const [bucket, quota] = await Promise.all([
		db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get(),
		getQuotaForUser(c.env, file.userId),
	]);
	if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
	if (quota.maxBucketSizeBytes !== null && bucket.usedBytes + currentOffset + contentLength > quota.maxBucketSizeBytes) {
		throw apiError(429, 'BUCKET_LIMIT_EXCEEDED');
	}

	const nextPartNumber = (maxPartNumber ?? 0) + 1;

	const multipartUpload = c.env.R2.resumeMultipartUpload(file.r2Key, file.uploadId);

	let uploadedPart: R2UploadedPart;
	try {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		uploadedPart = await multipartUpload.uploadPart(nextPartNumber, c.req.raw.body!);
	} catch (err) {
		throw apiError(400, 'INVALID_UPLOAD_OFFSET_HEADER', String(err));
	}

	await db.insert(uploadParts).values({
		id: genEaidx(Date.now()),
		fileId,
		partNumber: uploadedPart.partNumber,
		etag: uploadedPart.etag,
	});

	const newOffset = currentOffset + contentLength;

	return new Response(null, {
		status: 204,
		headers: {
			'Upload-Offset': String(newOffset),
			'Tus-Resumable': '1.0.0',
		},
	});
});

export const uploadRoutes = app;
