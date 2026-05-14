import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, max } from 'drizzle-orm';
import { files, uploadParts } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { genEaidx } from '../../shared/eaid-x';

const app = new Hono<{ Bindings: Env }>();

app.use('/upload/*', authMiddleware);

app.put('/upload/:fileId', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const fileId = c.req.param('fileId');

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();
	if (!file) throw new HTTPException(404, { message: 'File not found' });

	if (file.userId !== user.id && !user.isAdmin) {
		throw new HTTPException(403, { message: 'Forbidden' });
	}

	if (file.uploadExpiresAt < Date.now()) {
		throw new HTTPException(410, { message: 'Upload expired' });
	}

	try {
		await c.env.R2.put(file.r2Key, c.req.raw.body);
	} catch (err) {
		throw new HTTPException(400, { message: String(err) });
	}

	return new Response(null, { status: 204 });
});

app.get('/upload/:fileId/resume', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const fileId = c.req.param('fileId');

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();

	if (!file) {
		throw new HTTPException(404, { message: 'File not found' });
	}

	if (file.userId !== user.id && !user.isAdmin) {
		throw new HTTPException(403, { message: 'Forbidden' });
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

app.patch('/upload/:fileId/resume', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const fileId = c.req.param('fileId');
	const uploadOffset = c.req.header('Upload-Offset');
	if (!uploadOffset) {
		throw new HTTPException(400, { message: 'Upload-Offset header is required' });
	}

	const file = await db.select().from(files).where(eq(files.id, fileId)).get();

	if (!file) {
		throw new HTTPException(404, { message: 'File not found' });
	}

	if (file.userId !== user.id && !user.isAdmin) {
		throw new HTTPException(403, { message: 'Forbidden' });
	}

	if (file.uploadExpiresAt < Date.now()) {
		throw new HTTPException(410, { message: 'Upload expired' });
	}

	const currentOffset = parseInt(uploadOffset, 10);
	if (Number.isNaN(currentOffset)) {
		throw new HTTPException(400, { message: 'Invalid Upload-Offset header' });
	}

	const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);

	if (currentOffset === 0 && !file.uploadId) {
		const multipartUpload = await c.env.R2.createMultipartUpload(file.r2Key);
		await db.update(files).set({ uploadId: multipartUpload.uploadId }).where(eq(files.id, fileId));
		file.uploadId = multipartUpload.uploadId;
	}

	if (!file.uploadId) {
		throw new HTTPException(400, { message: 'Upload session not initialized' });
	}

	const [{ maxPartNumber }] = await db
		.select({
      maxPartNumber: max(uploadParts.partNumber),
    })
		.from(uploadParts)
		.where(eq(uploadParts.fileId, fileId));

	const nextPartNumber = (maxPartNumber ?? 0) + 1;

	const multipartUpload = c.env.R2.resumeMultipartUpload(file.r2Key, file.uploadId);

	let uploadedPart: R2UploadedPart;
	try {
		uploadedPart = await multipartUpload.uploadPart(nextPartNumber, c.req.raw.body!);
	} catch (err) {
		throw new HTTPException(400, { message: String(err) });
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

export default app;
