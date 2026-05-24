import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import * as v from 'valibot';
import { genEaidx, parseEaidx } from '../../shared/eaid-x';
import { apiError } from '../utils/api-error';
import { users, tokens, files, buckets, appSettings, userQuotas, globalQuotas, plans, userPlanAssignments, ipBans, fileReports, moderationEvents } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser, getGlobalQuota } from '../utils/rate-limit';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { KNOWN_SETTINGS, KnownSettingRecordSchema } from '../../shared/app-settings';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';
import { bumpWorkerCacheVersion } from '../utils/cache-names';
import { fileMutationEvents } from '../events/file-mutations';
import { toFileMutationReference, toFileMutationReferences } from '../utils/file-mutation-reference';
import { isValidCidr } from '../utils/cidr';

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
			throw apiError(400, 'USER_ID_IS_REQUIRED');
		}

		const user = await db.select().from(users).where(eq(users.id, body.userId)).get();

		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		await db.update(users).set({ isSuspended: true }).where(eq(users.id, body.userId));
		await db.delete(tokens).where(eq(tokens.userId, body.userId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/suspend-user')),
);

app.post(
	'/unsuspend-user',
	describeRoute(omitResAndReq(apiDef['/api/admin/unsuspend-user'])),
	validator('json', apiDef['/api/admin/unsuspend-user'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/unsuspend-user', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

		if (!body.userId) {
			throw apiError(400, 'USER_ID_IS_REQUIRED');
		}

		const user = await db.select().from(users).where(eq(users.id, body.userId)).get();

		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		await db.update(users).set({ isSuspended: false }).where(eq(users.id, body.userId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/unsuspend-user')),
);

app.post(
	'/make-admin',
	describeRoute(omitResAndReq(apiDef['/api/admin/make-admin'])),
	validator('json', apiDef['/api/admin/make-admin'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/make-admin', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

		if (!body.userId) {
			throw apiError(400, 'USER_ID_IS_REQUIRED');
		}

		const user = await db.select().from(users).where(eq(users.id, body.userId)).get();

		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		await db.update(users).set({ isAdmin: true }).where(eq(users.id, body.userId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/make-admin')),
);

app.post(
	'/list-ip-bans',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-ip-bans'])),
	validator('json', apiDef['/api/admin/list-ip-bans'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-ip-bans', Env>) => {
		const db = getDb(c.env);
		const rows = await db
			.select({
				id: ipBans.id,
				cidr: ipBans.cidr,
				reason: ipBans.reason,
				sourceEventId: ipBans.sourceEventId,
				createdBy: ipBans.createdBy,
				createdByUsername: users.username,
				expiresAt: ipBans.expiresAt,
			})
			.from(ipBans)
			.leftJoin(users, eq(ipBans.createdBy, users.id))
			.orderBy(desc(ipBans.id));

		return c.json(rows.map(row => ({
			id: row.id,
			cidr: row.cidr,
			reason: row.reason,
			sourceEventId: row.sourceEventId,
			createdBy: row.createdBy,
			createdByUsername: row.createdByUsername,
			expiresAt: row.expiresAt,
			createdAt: parseEaidx(row.id).date.getTime(),
		})), 200);
	}, getResponseDefWithAuth('/api/admin/list-ip-bans')),
);

app.post(
	'/create-ip-ban',
	describeRoute(omitResAndReq(apiDef['/api/admin/create-ip-ban'])),
	validator('json', apiDef['/api/admin/create-ip-ban'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/create-ip-ban', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const cidr = body.cidr.trim();

		if (!isValidCidr(cidr)) {
			throw apiError(400, 'INVALID_CIDR');
		}

		const id = genEaidx(Date.now());
		const row = {
			id,
			cidr,
			reason: body.reason ?? null,
			sourceEventId: body.sourceEventId ?? null,
			createdBy: user.id,
			expiresAt: body.expiresAt ?? null,
		};
		await db.insert(ipBans).values(row);

		return c.json({
			...row,
			createdByUsername: user.username,
			createdAt: parseEaidx(id).date.getTime(),
		}, 200);
	}, getResponseDefWithAuth('/api/admin/create-ip-ban')),
);

app.post(
	'/delete-ip-ban',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-ip-ban'])),
	validator('json', apiDef['/api/admin/delete-ip-ban'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-ip-ban', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		await db.delete(ipBans).where(eq(ipBans.id, body.banId));
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-ip-ban')),
);

app.post(
	'/list-file-reports',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-file-reports'])),
	validator('json', apiDef['/api/admin/list-file-reports'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-file-reports', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const fileOwners = alias(users, 'file_owners');
		const query = db
			.select({
				id: fileReports.id,
				fileId: fileReports.fileId,
				bucketName: buckets.name,
				filePath: files.path,
				fileSize: files.size,
				fileMimeType: files.mimeType,
				fileOwnerId: files.userId,
				fileOwnerUsername: fileOwners.username,
				reporterName: fileReports.reporterName,
				reporterEmail: fileReports.reporterEmail,
				reasonId: fileReports.reasonId,
				relationshipId: fileReports.relationshipId,
				contact: fileReports.contact,
				summary: fileReports.summary,
				detail: fileReports.detail,
				status: fileReports.status,
				adminNote: fileReports.adminNote,
				reporterIpAddress: fileReports.reporterIpAddress,
				reporterUserAgent: fileReports.reporterUserAgent,
				createdAt: fileReports.createdAt,
				updatedAt: fileReports.updatedAt,
			})
			.from(fileReports)
			.leftJoin(files, eq(fileReports.fileId, files.id))
			.leftJoin(buckets, eq(files.bucketId, buckets.id))
			.leftJoin(fileOwners, eq(files.userId, fileOwners.id))
			.orderBy(desc(fileReports.id));

		const rows = body.status ? await query.where(eq(fileReports.status, body.status)) : await query;
		return c.json(rows.map(row => ({
			...row,
			uploadEventId: null,
			uploadIpAddress: null,
			uploadUserAgent: null,
			uploadedAt: null,
		})), 200);
	}, getResponseDefWithAuth('/api/admin/list-file-reports')),
);

app.post(
	'/get-file-report',
	describeRoute(omitResAndReq(apiDef['/api/admin/get-file-report'])),
	validator('json', apiDef['/api/admin/get-file-report'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/get-file-report', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const fileOwners = alias(users, 'file_owners');
		const row = await db
			.select({
				id: fileReports.id,
				fileId: fileReports.fileId,
				bucketName: buckets.name,
				filePath: files.path,
				fileSize: files.size,
				fileMimeType: files.mimeType,
				fileOwnerId: files.userId,
				fileOwnerUsername: fileOwners.username,
				reporterName: fileReports.reporterName,
				reporterEmail: fileReports.reporterEmail,
				reasonId: fileReports.reasonId,
				relationshipId: fileReports.relationshipId,
				contact: fileReports.contact,
				summary: fileReports.summary,
				detail: fileReports.detail,
				status: fileReports.status,
				adminNote: fileReports.adminNote,
				reporterIpAddress: fileReports.reporterIpAddress,
				reporterUserAgent: fileReports.reporterUserAgent,
				createdAt: fileReports.createdAt,
				updatedAt: fileReports.updatedAt,
			})
			.from(fileReports)
			.leftJoin(files, eq(fileReports.fileId, files.id))
			.leftJoin(buckets, eq(files.bucketId, buckets.id))
			.leftJoin(fileOwners, eq(files.userId, fileOwners.id))
			.where(eq(fileReports.id, body.reportId))
			.get();

		if (!row) throw apiError(404, 'FILE_REPORT_NOT_FOUND');
		const uploadEvent = await db
			.select({
				id: moderationEvents.id,
				ipAddress: moderationEvents.ipAddress,
				userAgent: moderationEvents.userAgent,
			})
			.from(moderationEvents)
			.where(and(
				eq(moderationEvents.action, 'file_uploaded'),
				sql`json_extract(${moderationEvents.data}, '$.fileId') = ${row.fileId}`,
			))
			.orderBy(desc(moderationEvents.id))
			.get();

		return c.json({
			...row,
			uploadEventId: uploadEvent?.id ?? null,
			uploadIpAddress: uploadEvent?.ipAddress ?? null,
			uploadUserAgent: uploadEvent?.userAgent ?? null,
			uploadedAt: uploadEvent ? parseEaidx(uploadEvent.id).date.getTime() : null,
		}, 200);
	}, getResponseDefWithAuth('/api/admin/get-file-report')),
);

app.post(
	'/update-file-report',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-file-report'])),
	validator('json', apiDef['/api/admin/update-file-report'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-file-report', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const report = await db.select({ id: fileReports.id }).from(fileReports).where(eq(fileReports.id, body.reportId)).get();
		if (!report) throw apiError(404, 'FILE_REPORT_NOT_FOUND');

		await db
			.update(fileReports)
			.set({
				status: body.status,
				adminNote: body.adminNote,
				updatedAt: Date.now(),
			})
			.where(eq(fileReports.id, body.reportId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/update-file-report')),
);

app.post(
	'/delete-file',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-file'])),
	validator('json', apiDef['/api/admin/delete-file'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-file', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

		if (!body.fileId) {
			throw apiError(400, 'FILE_ID_IS_REQUIRED');
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();

		if (!file) {
			throw apiError(404, 'FILE_NOT_FOUND');
		}
		const bucket = await db.select({ id: buckets.id, name: buckets.name }).from(buckets).where(eq(buckets.id, file.bucketId)).get();
		const purgeFile = await toFileMutationReference(db, file);

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

		if (bucket) {
			fileMutationEvents.emit('file:deleted', {
				env: c.env,
				origin: new URL(c.req.url).origin,
				waitUntil: promise => c.executionCtx.waitUntil(promise),
				bucket,
				files: [purgeFile],
			});
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
			throw apiError(400, 'BUCKET_NOT_FOUND', 'bucketId is required');
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, body.bucketId)).get();

		if (!bucket) {
			throw apiError(404, 'BUCKET_NOT_FOUND');
		}

		const bucketFiles = await db.select().from(files).where(eq(files.bucketId, bucket.id));
		const purgeFiles = await toFileMutationReferences(db, bucketFiles);

		for (const file of bucketFiles) {
			try {
				await c.env.R2.delete(file.r2Key);
			} catch (error) {
				console.error('Failed to delete R2 object:', file.r2Key, error);
			}
		}

		await db.delete(buckets).where(eq(buckets.id, bucket.id));

		fileMutationEvents.emit('bucket:deleted', {
			env: c.env,
			origin: new URL(c.req.url).origin,
			waitUntil: promise => c.executionCtx.waitUntil(promise),
			bucket: { id: bucket.id, name: bucket.name },
			files: purgeFiles,
		});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-bucket')),
);

app.post(
	'/purge-worker-cache',
	describeRoute(omitResAndReq(apiDef['/api/admin/purge-worker-cache'])),
	validator('json', apiDef['/api/admin/purge-worker-cache'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/purge-worker-cache', Env>) => {
		const version = await bumpWorkerCacheVersion(c.env);
		return c.json({ ok: true, version }, 200);
	}, getResponseDefWithAuth('/api/admin/purge-worker-cache')),
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
			throw apiError(404, 'USER_NOT_FOUND');
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
	'/get-user-custom-quota',
	describeRoute(omitResAndReq(apiDef['/api/admin/get-user-custom-quota'])),
	validator('json', apiDef['/api/admin/get-user-custom-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/get-user-custom-quota', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const user = await db.select({ id: users.id }).from(users).where(eq(users.id, body.userId)).get();
		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		const userQuota = await db.select().from(userQuotas).where(eq(userQuotas.userId, body.userId)).get();
		return c.json({
			exists: userQuota != null,
			quota: {
				maxBuckets: userQuota?.maxBuckets ?? null,
				maxBucketSizeBytes: userQuota?.maxBucketSizeBytes ?? null,
				maxFilesPerBucket: userQuota?.maxFilesPerBucket ?? null,
				maxDailyUploads: userQuota?.maxDailyUploads ?? null,
			},
		}, 200);
	}, getResponseDefWithAuth('/api/admin/get-user-custom-quota')),
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
			throw apiError(404, 'USER_NOT_FOUND');
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
	'/update-setting',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-setting'])),
	validator('json', apiDef['/api/admin/update-setting'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-setting', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

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
		const knownSettings = settings
			.filter((setting): setting is typeof settings[number] & { key: keyof typeof KNOWN_SETTINGS } => setting.key in KNOWN_SETTINGS)
			.map((setting) => v.parse(KnownSettingRecordSchema, setting));

		return c.json(knownSettings, 200);
	}, getResponseDefWithAuth('/api/admin/get-settings')),
);

app.post(
	'/list-plans',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-plans'])),
	validator('json', apiDef['/api/admin/list-plans'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-plans', Env>) => {
		const db = getDb(c.env);
		const allPlans = await db.select().from(plans).all();
		return c.json(allPlans, 200);
	}, getResponseDefWithAuth('/api/admin/list-plans')),
);

app.post(
	'/create-plan',
	describeRoute(omitResAndReq(apiDef['/api/admin/create-plan'])),
	validator('json', apiDef['/api/admin/create-plan'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/create-plan', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const now = Date.now();
		const plan = {
			id: genEaidx(now),
			name: body.name,
			maxBuckets: body.maxBuckets ?? null,
			maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
			maxFilesPerBucket: body.maxFilesPerBucket ?? null,
			maxDailyUploads: body.maxDailyUploads ?? null,
			createdAt: now,
			updatedAt: now,
		};

		await db.insert(plans).values(plan);

		return c.json(plan, 200);
	}, getResponseDefWithAuth('/api/admin/create-plan')),
);

app.post(
	'/update-plan',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-plan'])),
	validator('json', apiDef['/api/admin/update-plan'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-plan', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select().from(plans).where(eq(plans.id, body.planId)).get();
		if (!existing) {
			throw apiError(404, 'PLAN_NOT_FOUND');
		}

		const updated = {
			id: existing.id,
			name: body.name,
			maxBuckets: body.maxBuckets ?? null,
			maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
			maxFilesPerBucket: body.maxFilesPerBucket ?? null,
			maxDailyUploads: body.maxDailyUploads ?? null,
			createdAt: existing.createdAt,
			updatedAt: Date.now(),
		};

		await db.update(plans).set({
			name: updated.name,
			maxBuckets: updated.maxBuckets,
			maxBucketSizeBytes: updated.maxBucketSizeBytes,
			maxFilesPerBucket: updated.maxFilesPerBucket,
			maxDailyUploads: updated.maxDailyUploads,
			updatedAt: updated.updatedAt,
		}).where(eq(plans.id, body.planId));

		return c.json(updated, 200);
	}, getResponseDefWithAuth('/api/admin/update-plan')),
);

app.post(
	'/delete-plan',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-plan'])),
	validator('json', apiDef['/api/admin/delete-plan'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-plan', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select({ id: plans.id }).from(plans).where(eq(plans.id, body.planId)).get();
		if (!existing) {
			throw apiError(404, 'PLAN_NOT_FOUND');
		}

		await db.delete(plans).where(eq(plans.id, body.planId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-plan')),
);

app.post(
	'/assign-user-plan',
	describeRoute(omitResAndReq(apiDef['/api/admin/assign-user-plan'])),
	validator('json', apiDef['/api/admin/assign-user-plan'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/assign-user-plan', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const [user, plan] = await Promise.all([
			db.select({ id: users.id }).from(users).where(eq(users.id, body.userId)).get(),
			db.select({ id: plans.id }).from(plans).where(eq(plans.id, body.planId)).get(),
		]);
		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}
		if (!plan) {
			throw apiError(404, 'PLAN_NOT_FOUND');
		}

		const now = Date.now();
		await db
			.insert(userPlanAssignments)
			.values({
				userId: body.userId,
				planId: body.planId,
				expiresAt: body.expiresAt,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: userPlanAssignments.userId,
				set: {
					planId: body.planId,
					expiresAt: body.expiresAt,
					updatedAt: now,
				},
			});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/assign-user-plan')),
);

app.post(
	'/get-user-plan',
	describeRoute(omitResAndReq(apiDef['/api/admin/get-user-plan'])),
	validator('json', apiDef['/api/admin/get-user-plan'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/get-user-plan', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const user = await db.select({ id: users.id }).from(users).where(eq(users.id, body.userId)).get();
		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		const assignment = await db
			.select({
				userId: userPlanAssignments.userId,
				planId: userPlanAssignments.planId,
				planName: plans.name,
				expiresAt: userPlanAssignments.expiresAt,
				createdAt: userPlanAssignments.createdAt,
				updatedAt: userPlanAssignments.updatedAt,
			})
			.from(userPlanAssignments)
			.innerJoin(plans, eq(userPlanAssignments.planId, plans.id))
			.where(eq(userPlanAssignments.userId, body.userId))
			.get();

		return c.json(assignment ?? null, 200);
	}, getResponseDefWithAuth('/api/admin/get-user-plan')),
);

app.post(
	'/delete-user-plan',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-user-plan'])),
	validator('json', apiDef['/api/admin/delete-user-plan'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-user-plan', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const user = await db.select({ id: users.id }).from(users).where(eq(users.id, body.userId)).get();
		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		await db.delete(userPlanAssignments).where(eq(userPlanAssignments.userId, body.userId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-user-plan')),
);

export const adminRoutes = app;
