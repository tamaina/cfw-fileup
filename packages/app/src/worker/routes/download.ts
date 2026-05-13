import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { buckets, files, targzFiles } from '../scheme/index';
import { getDb } from '../utils/db';

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get('/d/:bucketName/*', async (c) => {
	const db = getDb(c.env);
	const bucketName = c.req.param('bucketName');
	const filePath = c.req.param('*') || '';

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

		const startByte = indexEntry.aStart;
		const endByte = indexEntry.aEnd;

		try {
			const r2Object = await c.env.R2.get(file.r2Key, {
				range: {
					offset: startByte,
					length: endByte - startByte,
				},
			});

			if (!r2Object) {
				throw new HTTPException(404, { message: 'Failed to retrieve file' });
			}

			return new Response(r2Object.body, {
				headers: {
					'Content-Type': indexEntry.mimeType ?? 'application/octet-stream',
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

app.delete('/d/:bucketName/*', async (c) => {
	const db = getDb(c.env);
	const authorization = c.req.header('Authorization');

	if (!authorization?.startsWith('Bearer ')) {
		throw new HTTPException(401, { message: 'Unauthorized' });
	}

	const bucketName = c.req.param('bucketName');
	const filePath = c.req.param('*') || '';

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

	try {
		await c.env.R2.delete(file.r2Key);
	} catch (error) {
		console.error('Failed to delete R2 object:', file.r2Key, error);
	}

	await db.delete(files).where(eq(files.id, file.id));

	return c.json({ ok: true });
});

export default app;
