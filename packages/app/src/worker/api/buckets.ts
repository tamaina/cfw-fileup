import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { buckets, files } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser } from '../utils/rate-limit';
import { authMiddleware } from '../middleware/auth';
import { genEaidx } from '../../shared/eaid-x';
import { bucketsApiSchema } from './buckets.definition';
import type { ExtractRequestType, ExtractResponseType } from './schema-type';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

app.post('/create', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const body = (await c.req.json()) as ExtractRequestType<typeof bucketsApiSchema, '/api/buckets/create', 'post'>;

	if (!body.bucketName) {
		throw new HTTPException(400, { message: 'bucketName is required' });
	}

	const quota = await getQuotaForUser(c.env, user.id);
	if (quota.maxBuckets !== null) {
		const userBucketCount = await db.query.buckets
			.findMany({ where: eq(buckets.userId, user.id) })
			.then((result) => result.length);

		if (userBucketCount >= quota.maxBuckets) {
			throw new HTTPException(429, { message: 'Bucket limit exceeded' });
		}
	}

	const existingBucket = await db
		.select()
		.from(buckets)
		.where(eq(buckets.name, body.bucketName))
		.get();

	if (existingBucket) {
		throw new HTTPException(409, { message: 'Bucket name already exists' });
	}

	const bucketId = genEaidx(Date.now());

	await db.insert(buckets).values({
		id: bucketId,
		userId: user.id,
		name: body.bucketName,
	});

	return c.json({ bucketId } as ExtractResponseType<typeof bucketsApiSchema, '/api/buckets/create', 'post', 201>);
});

app.post('/delete', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const body = (await c.req.json()) as ExtractRequestType<typeof bucketsApiSchema, '/api/buckets/delete', 'post'>;

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

	const bucketFiles = await db.select().from(files).where(eq(files.bucketId, bucket.id));

	for (const file of bucketFiles) {
		try {
			await c.env.R2.delete(file.r2Key);
		} catch (error) {
			console.error('Failed to delete R2 object:', file.r2Key, error);
		}
	}

	await db.delete(buckets).where(eq(buckets.id, bucket.id));

	return c.json({ ok: true } as ExtractResponseType<typeof bucketsApiSchema, '/api/buckets/delete', 'post', 200>);
});

app.post('/list', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');

	const [userBuckets, quota] = await Promise.all([
		db
			.select({ id: buckets.id, name: buckets.name, usedBytes: buckets.usedBytes })
			.from(buckets)
			.where(eq(buckets.userId, user.id)),
		getQuotaForUser(c.env, user.id),
	]);

	return c.json({
		buckets: userBuckets,
		maxBucketSizeBytes: quota.maxBucketSizeBytes,
	} as ExtractResponseType<typeof bucketsApiSchema, '/api/buckets/list', 'post', 200>);
});

export default app;
