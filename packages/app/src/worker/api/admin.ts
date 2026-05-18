import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, sql } from 'drizzle-orm';
import { users, tokens, files, buckets, appSettings, userQuotas, globalQuotas } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser, getGlobalQuota } from '../utils/rate-limit';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { KNOWN_SETTINGS, KNOWN_SETTING_KEYS } from '../../shared/app-settings';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);
app.use(adminMiddleware);

app.post(
	'/suspend-user',
	describeRoute(omitResAndReq(apiDef['/api/admin/suspend-user'])),
	validator('json', apiDef['/api/admin/suspend-user'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/suspend-user', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

		if (!body.userId) {
			throw new HTTPException(400, { message: 'userId is required' });
		}

		const user = await db.select().from(users).where(eq(users.id, body.userId)).get();

		if (!user) {
			throw new HTTPException(404, { message: 'User not found' });
		}

		await db.update(users).set({ isSuspended: true }).where(eq(users.id, body.userId));
		await db.delete(tokens).where(eq(tokens.userId, body.userId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/suspend-user')),
);

app.post(
	'/delete-file',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-file'])),
	validator('json', apiDef['/api/admin/delete-file'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-file', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

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

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-file')),
);

app.post(
	'/delete-bucket',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-bucket'])),
	validator('json', apiDef['/api/admin/delete-bucket'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-bucket', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

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

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-bucket')),
);

app.post(
	'/set-user-quota',
	describeRoute(omitResAndReq(apiDef['/api/admin/set-user-quota'])),
	validator('json', apiDef['/api/admin/set-user-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/set-user-quota', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const userId = body.userId;

		const user = await db.select().from(users).where(eq(users.id, userId)).get();
		if (!user) {
			throw new HTTPException(404, { message: 'User not found' });
		}

		const now = Date.now();

		await db
			.insert(userQuotas)
			.values({
				userId,
				maxBuckets: body.maxBuckets ?? null,
				maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
				maxFilesPerBucket: body.maxFilesPerBucket ?? null,
				maxDailyUploads: body.maxDailyUploads ?? null,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: userQuotas.userId,
				set: {
					maxBuckets: body.maxBuckets ?? null,
					maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
					maxFilesPerBucket: body.maxFilesPerBucket ?? null,
					maxDailyUploads: body.maxDailyUploads ?? null,
					updatedAt: now,
				},
			});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/set-user-quota')),
);

app.post(
	'/set-global-quota',
	describeRoute(omitResAndReq(apiDef['/api/admin/set-global-quota'])),
	validator('json', apiDef['/api/admin/set-global-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/set-global-quota', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

		await db
			.insert(globalQuotas)
			.values({
				key: 'default',
				maxBuckets: body.maxBuckets ?? null,
				maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
				maxFilesPerBucket: body.maxFilesPerBucket ?? null,
				maxDailyUploads: body.maxDailyUploads ?? null,
			})
			.onConflictDoUpdate({
				target: globalQuotas.key,
				set: {
					maxBuckets: body.maxBuckets ?? null,
					maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
					maxFilesPerBucket: body.maxFilesPerBucket ?? null,
					maxDailyUploads: body.maxDailyUploads ?? null,
				},
			});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/set-global-quota')),
);

app.post(
	'/get-user-quota',
	describeRoute(omitResAndReq(apiDef['/api/admin/get-user-quota'])),
	validator('json', apiDef['/api/admin/get-user-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/get-user-quota', Env>) => {
		const body = c.req.valid('json');
		const quota = await getQuotaForUser(c.env, body.userId);

		return c.json(quota, 200);
	}, getResponseDefWithAuth('/api/admin/get-user-quota')),
);

app.post(
	'/get-global-quota',
	describeRoute(omitResAndReq(apiDef['/api/admin/get-global-quota'])),
	validator('json', apiDef['/api/admin/get-global-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/get-global-quota', Env>) => {
		const quota = await getGlobalQuota(c.env);

		return c.json(quota, 200);
	}, getResponseDefWithAuth('/api/admin/get-global-quota')),
);

app.post(
	'/delete-user-quota',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-user-quota'])),
	validator('json', apiDef['/api/admin/delete-user-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-user-quota', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

		const user = await db.select().from(users).where(eq(users.id, body.userId)).get();
		if (!user) {
			throw new HTTPException(404, { message: 'User not found' });
		}

		await db.delete(userQuotas).where(eq(userQuotas.userId, body.userId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-user-quota')),
);

app.post(
	'/list-users',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-users'])),
	validator('json', apiDef['/api/admin/list-users'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-users', Env>) => {
		const db = getDb(c.env);
		const allUsers = await db.select({
			id: users.id,
			username: users.username,
			isAdmin: users.isAdmin,
			isSuspended: users.isSuspended,
		}).from(users).all();
		return c.json(allUsers, 200);
	}, getResponseDefWithAuth('/api/admin/list-users')),
);

app.post(
	'/toggle-registration',
	describeRoute(omitResAndReq(apiDef['/api/admin/toggle-registration'])),
	validator('json', apiDef['/api/admin/toggle-registration'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/toggle-registration', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

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

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/toggle-registration')),
);

app.post(
	'/update-setting',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-setting'])),
	validator('json', apiDef['/api/admin/update-setting'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-setting', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

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

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/update-setting')),
);

app.post(
	'/get-settings',
	describeRoute(omitResAndReq(apiDef['/api/admin/get-settings'])),
	validator('json', apiDef['/api/admin/get-settings'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/get-settings', Env>) => {
		const db = getDb(c.env);
		const settings = await db.select().from(appSettings);

		return c.json(settings, 200);
	}, getResponseDefWithAuth('/api/admin/get-settings')),
);

export const adminRoutes = app;
