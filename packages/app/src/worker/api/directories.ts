import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, like, sql } from 'drizzle-orm';
import { buckets, files, directories } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { genEaidx } from '../../shared/eaid-x';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

app.post('/create', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const { bucketId, path } = await c.req.json() as { bucketId?: string; path?: string };

	if (!bucketId || !path) throw new HTTPException(400, { message: 'bucketId and path are required' });

	const normalizedPath = path.endsWith('/') ? path : `${path}/`;

	const bucket = await db.select().from(buckets).where(eq(buckets.id, bucketId)).get();
	if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });
	if (bucket.userId !== user.id && !user.isAdmin) throw new HTTPException(403, { message: 'Forbidden' });

	await db.insert(directories).values({
		id: genEaidx(Date.now()),
		bucketId: bucket.id,
		path: normalizedPath,
	}).onConflictDoNothing();

	return c.json({ ok: true });
});

app.post('/delete', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const { bucketId, path } = await c.req.json() as { bucketId?: string; path?: string };

	if (!bucketId || !path) throw new HTTPException(400, { message: 'bucketId and path are required' });

	const bucket = await db.select().from(buckets).where(eq(buckets.id, bucketId)).get();
	if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });
	if (bucket.userId !== user.id && !user.isAdmin) throw new HTTPException(403, { message: 'Forbidden' });

	// Delete all files under this directory (including R2 objects)
	const childFiles = await db
		.select({ id: files.id, r2Key: files.r2Key, isClosed: files.isClosed, size: files.size })
		.from(files)
		.where(and(eq(files.bucketId, bucket.id), like(files.path, `${path}%`)));

	for (const f of childFiles) {
		try { await c.env.R2.delete(f.r2Key); } catch { /* ignore */ }
	}
	if (childFiles.length > 0) {
		for (const f of childFiles) {
			await db.delete(files).where(eq(files.id, f.id));
		}
		const sizeToDecrement = childFiles.reduce((sum, f) => sum + (f.isClosed && f.size ? f.size : 0), 0);
		if (sizeToDecrement > 0) {
			await db
				.update(buckets)
				.set({ usedBytes: sql`MAX(0, ${buckets.usedBytes} - ${sizeToDecrement})` })
				.where(eq(buckets.id, bucket.id));
		}
	}

	// Delete all sub-directory entries and the directory itself
	await db.delete(directories).where(and(eq(directories.bucketId, bucket.id), like(directories.path, `${path}%`)));

	return c.json({ ok: true });
});

export const directoryRoutes = app;
