import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, sql } from 'drizzle-orm';
import { users, tokens, files, buckets, appSettings, userQuotas, globalQuotas } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser, getGlobalQuota } from '../utils/rate-limit';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { KNOWN_SETTINGS, KNOWN_SETTING_KEYS } from '../../shared/app-settings';
import { adminApiSchema } from './admin.definition';
import type { ExtractRequestType, ExtractResponseType } from './schema-type';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);
app.use(adminMiddleware);

app.post('/suspend-user', async (c) => {
	const db = getDb(c.env);
	type SuspendUserReq = ExtractRequestType<typeof adminApiSchema, '/api/admin/suspend-user', 'post'>;
	const body = (await c.req.json()) as SuspendUserReq;

	if (!body.userId) {
		throw new HTTPException(400, { message: 'userId is required' });
	}

	const user = await db.select().from(users).where(eq(users.id, body.userId)).get();

	if (!user) {
		throw new HTTPException(404, { message: 'User not found' });
	}

	await db.update(users).set({ isSuspended: true }).where(eq(users.id, body.userId));

	await db.delete(tokens).where(eq(tokens.userId, body.userId));

	return c.json({ ok: true } as ExtractResponseType<typeof adminApiSchema, '/api/admin/suspend-user', 'post', 200>);
});

app.post('/delete-file', async (c) => {
	const db = getDb(c.env);
	type DeleteFileAdminReq = ExtractRequestType<typeof adminApiSchema, '/api/admin/delete-file', 'post'>;
	const body = (await c.req.json()) as DeleteFileAdminReq;

	if (!body.fileId) {
		throw new HTTPException(400, { message: 'fileId is required' });
	}

	const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();

	if (!file) {
		throw new HTTPException(404, { message: 'File not found' });
	}

	try {
		await c.env.R2.delete(file.r2Key);
	} catch (error) {
		console.error('Failed to delete R2 object:', file.r2Key, error);
	}

	await db.delete(files).where(eq(files.id, body.fileId));

	if (file.isClosed && file.size) {
		await db
			.update(buckets)
			.set({ usedBytes: sql`MAX(0, ${buckets.usedBytes} - ${file.size})` })
			.where(eq(buckets.id, file.bucketId));
	}

	return c.json({ ok: true } as ExtractResponseType<typeof adminApiSchema, '/api/admin/delete-file', 'post', 200>);
});

app.post('/delete-bucket', async (c) => {
	const db = getDb(c.env);
	type DeleteBucketAdminReq = ExtractRequestType<typeof adminApiSchema, '/api/admin/delete-bucket', 'post'>;
	const body = (await c.req.json()) as DeleteBucketAdminReq;

	if (!body.bucketId) {
		throw new HTTPException(400, { message: 'bucketId is required' });
	}

	const bucket = await db.select().from(buckets).where(eq(buckets.id, body.bucketId)).get();

	if (!bucket) {
		throw new HTTPException(404, { message: 'Bucket not found' });
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

	return c.json({ ok: true } as ExtractResponseType<typeof adminApiSchema, '/api/admin/delete-bucket', 'post', 200>);
});

app.post('/set-user-quota/:userId', async (c) => {
	const db = getDb(c.env);
	const body = (await c.req.json()) as Record<string, unknown>;

	const userId = c.req.param('userId');

	const user = await db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) {
		throw new HTTPException(404, { message: 'User not found' });
	}

	const now = Date.now();

	await db
		.insert(userQuotas)
		.values({
			userId,
			maxBuckets: body.maxBuckets ? Number(body.maxBuckets) : null,
			maxBucketSizeBytes: body.maxBucketSizeBytes ? Number(body.maxBucketSizeBytes) : null,
			maxFilesPerBucket: body.maxFilesPerBucket ? Number(body.maxFilesPerBucket) : null,
			maxDailyUploads: body.maxDailyUploads ? Number(body.maxDailyUploads) : null,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: userQuotas.userId,
			set: {
				maxBuckets: body.maxBuckets ? Number(body.maxBuckets) : null,
				maxBucketSizeBytes: body.maxBucketSizeBytes ? Number(body.maxBucketSizeBytes) : null,
				maxFilesPerBucket: body.maxFilesPerBucket ? Number(body.maxFilesPerBucket) : null,
				maxDailyUploads: body.maxDailyUploads ? Number(body.maxDailyUploads) : null,
				updatedAt: now,
			},
		});

	return c.json({ ok: true } as ExtractResponseType<typeof adminApiSchema, '/api/admin/set-user-quota/:userId', 'post', 200>);
});

app.post('/set-global-quota', async (c) => {
	const db = getDb(c.env);
	const body = (await c.req.json()) as Record<string, unknown>;

	await db
		.insert(globalQuotas)
		.values({
			key: 'default',
			maxBuckets: body.maxBuckets ? Number(body.maxBuckets) : null,
			maxBucketSizeBytes: body.maxBucketSizeBytes ? Number(body.maxBucketSizeBytes) : null,
			maxFilesPerBucket: body.maxFilesPerBucket ? Number(body.maxFilesPerBucket) : null,
			maxDailyUploads: body.maxDailyUploads ? Number(body.maxDailyUploads) : null,
		})
		.onConflictDoUpdate({
			target: globalQuotas.key,
			set: {
				maxBuckets: body.maxBuckets ? Number(body.maxBuckets) : null,
				maxBucketSizeBytes: body.maxBucketSizeBytes ? Number(body.maxBucketSizeBytes) : null,
				maxFilesPerBucket: body.maxFilesPerBucket ? Number(body.maxFilesPerBucket) : null,
				maxDailyUploads: body.maxDailyUploads ? Number(body.maxDailyUploads) : null,
			},
		});

	return c.json({ ok: true } as ExtractResponseType<typeof adminApiSchema, '/api/admin/set-global-quota', 'post', 200>);
});

app.post('/get-user-quota/:userId', async (c) => {
	const userId = c.req.param('userId');
	const quota = await getQuotaForUser(c.env, userId);

	return c.json(quota as ExtractResponseType<typeof adminApiSchema, '/api/admin/get-user-quota/:userId', 'post', 200>);
});

app.post('/get-global-quota', async (c) => {
	const quota = await getGlobalQuota(c.env);

	return c.json(quota as ExtractResponseType<typeof adminApiSchema, '/api/admin/get-global-quota', 'post', 200>);
});

app.post('/delete-user-quota/:userId', async (c) => {
	const db = getDb(c.env);
	const userId = c.req.param('userId');

	const user = await db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) {
		throw new HTTPException(404, { message: 'User not found' });
	}

	await db.delete(userQuotas).where(eq(userQuotas.userId, userId));

	return c.json({ ok: true } as ExtractResponseType<typeof adminApiSchema, '/api/admin/delete-user-quota/:userId', 'post', 200>);
});

app.post('/list-users', async (c) => {
	const db = getDb(c.env);
	const allUsers = await db.select({
		id: users.id,
		username: users.username,
		isAdmin: users.isAdmin,
		isSuspended: users.isSuspended,
	}).from(users).all();
	return c.json(allUsers);
});

app.post('/toggle-registration', async (c) => {
	const db = getDb(c.env);
	type ToggleRegistrationReq = ExtractRequestType<typeof adminApiSchema, '/api/admin/toggle-registration', 'post'>;
	const body = (await c.req.json()) as ToggleRegistrationReq;

	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (body.enabled === undefined || body.enabled === null) {
		throw new HTTPException(400, { message: 'enabled is required' });
	}

	const value = body.enabled ? 'true' : 'false';

	await db
		.insert(appSettings)
		.values({
			key: 'registration_enabled',
			value,
		})
		.onConflictDoUpdate({
			target: appSettings.key,
			set: { value },
		});

	return c.json({ ok: true } as ExtractResponseType<typeof adminApiSchema, '/api/admin/toggle-registration', 'post', 200>);
});

app.post('/update-setting', async (c) => {
	const db = getDb(c.env);
	type UpdateSettingReq = ExtractRequestType<typeof adminApiSchema, '/api/admin/update-setting', 'post'>;
	const body = (await c.req.json()) as UpdateSettingReq;

	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (!body.key || body.value === undefined) {
		throw new HTTPException(400, { message: 'key and value are required' });
	}

	if (!KNOWN_SETTING_KEYS.includes(body.key)) {
		throw new HTTPException(400, { message: `Unknown setting key: ${body.key}` });
	}

	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const settingDef = KNOWN_SETTINGS.find((s) => s.key === body.key)!;
	 
	if (settingDef.type === 'boolean' && body.value !== 'true' && body.value !== 'false') {
		throw new HTTPException(400, { message: `Value for "${body.key}" must be "true" or "false"` });
	}

	await db
		.insert(appSettings)
		.values({
			key: body.key,
			value: body.value,
		})
		.onConflictDoUpdate({
			target: appSettings.key,
			set: { value: body.value },
		});

	return c.json({ ok: true } as ExtractResponseType<typeof adminApiSchema, '/api/admin/update-setting', 'post', 200>);
});

app.post('/get-settings', async (c) => {
	const db = getDb(c.env);
	const settings = await db.select().from(appSettings);

	return c.json(settings as ExtractResponseType<typeof adminApiSchema, '/api/admin/get-settings', 'post', 200>);
});

export const adminRoutes = app;
