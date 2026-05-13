import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { files, uploadParts } from '../scheme/index';
import { getDb } from '../utils/db';
import { genEaidx } from '../../shared/eaid-x';

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get('/upload/:fileId', async (c) => {
	const db = getDb(c.env);
	const fileId = c.req.param('fileId');

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();

	if (!file) {
		throw new HTTPException(404, { message: 'File not found' });
	}

	if (file.uploadExpiresAt < Date.now()) {
		throw new HTTPException(410, { message: 'Upload expired' });
	}

	const r2Object = await c.env.R2.head(file.r2Key);
	const offset = r2Object?.size ?? 0;

	return new Response(null, {
		status: 200,
		headers: {
			'Upload-Offset': String(offset),
			'Tus-Resumable': '1.0.0',
		},
	});
});

app.patch('/upload/:fileId', async (c) => {
	const db = getDb(c.env);
	const fileId = c.req.param('fileId');
	const uploadOffset = c.req.header('Upload-Offset');

	if (!uploadOffset) {
		throw new HTTPException(400, { message: 'Upload-Offset header is required' });
	}

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();

	if (!file) {
		throw new HTTPException(404, { message: 'File not found' });
	}

	if (file.uploadExpiresAt < Date.now()) {
		throw new HTTPException(410, { message: 'Upload expired' });
	}

	const currentOffset = parseInt(uploadOffset, 10);
	if (Number.isNaN(currentOffset)) {
		throw new HTTPException(400, { message: 'Invalid Upload-Offset header' });
	}

	const body = await c.req.arrayBuffer();

	if (currentOffset === 0 && !file.uploadId) {
		const multipartUpload = await c.env.R2.createMultipartUpload(file.r2Key);
		await db.update(files).set({ uploadId: multipartUpload.uploadId }).where(eq(files.id, fileId));
		file.uploadId = multipartUpload.uploadId;
	}

	if (!file.uploadId) {
		throw new HTTPException(400, { message: 'Upload session not initialized' });
	}

	const partNumber = currentOffset === 0 ? 1 : Math.floor(currentOffset / (5 * 1024 * 1024)) + 1;

	const multipartUpload = c.env.R2.resumeMultipartUpload(file.r2Key, file.uploadId);
	const uploadedPart = await multipartUpload.uploadPart(partNumber, body);

	const uploadPartId = genEaidx(Date.now());
	await db.insert(uploadParts).values({
		id: uploadPartId,
		fileId,
		partNumber,
		etag: uploadedPart.etag,
	});

	const newOffset = currentOffset + body.byteLength;

	return new Response(null, {
		status: 204,
		headers: {
			'Upload-Offset': String(newOffset),
			'Tus-Resumable': '1.0.0',
		},
	});
});

export default app;
