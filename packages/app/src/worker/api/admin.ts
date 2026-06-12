import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { and, asc, desc, eq, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import * as v from 'valibot';
import { genEaidx, parseEaidx } from '../../shared/eaid-x';
import { apiError } from '../utils/api-error';
import { users, tokens, files, buckets, appSettings, userQuotas, globalQuotas, plans, userPlanAssignments, ipBans, fileReports, moderationEvents, moderationAuditLogs } from '../scheme/index';
import { getDb } from '../utils/db';
import {
	getQuotaForUser,
	getGlobalQuota,
	getStoredEffectiveQuotaForUser,
	refreshEffectiveQuotaForUser,
	refreshEffectiveQuotaForPlanUsers,
	refreshEffectiveQuotaForGlobalFallbackUsers,
} from '../utils/rate-limit';
import { authMiddleware, adminMiddleware, moderatorMiddleware } from '../middleware/auth';
import { KNOWN_SETTINGS, KnownSettingRecordSchema } from '../../shared/app-settings';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';
import { bumpWorkerCacheVersion } from '../utils/cache-names';
import { fileMutationEvents } from '../events/file-mutations';
import { toFileMutationReference, toFileMutationReferences } from '../utils/file-mutation-reference';
import { isValidCidr } from '../utils/cidr';
import { recordModerationAuditLog } from '../utils/moderation';
import { idPage, pageParams } from '../utils/pagination';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

const moderatorPaths = [
	'/list-ip-bans',
	'/create-ip-ban',
	'/delete-ip-ban',
	'/list-file-reports',
	'/get-file-report',
	'/update-file-report',
	'/list-files',
	'/list-moderation-audit-logs',
	'/update-file-moderation',
	'/delete-file',
] as const;

const adminOnlyPaths = [
	'/suspend-user',
	'/unsuspend-user',
	'/make-admin',
	'/update-moderator',
	'/delete-bucket',
	'/purge-worker-cache',
	'/set-user-quota',
	'/set-global-quota',
	'/get-user-quota',
	'/get-user-effective-quota',
	'/recalculate-user-effective-quota',
	'/get-user-custom-quota',
	'/get-global-quota',
	'/delete-user-quota',
	'/list-users',
	'/update-setting',
	'/get-settings',
	'/list-plans',
	'/create-plan',
	'/update-plan',
	'/assign-user-plan',
	'/get-user-plan',
	'/delete-user-plan',
] as const;

for (const path of moderatorPaths) app.use(path, moderatorMiddleware);
for (const path of adminOnlyPaths) app.use(path, adminMiddleware);

async function getNextPlanSortOrder(env: Env): Promise<number> {
	const latestPlan = await getDb(env)
		.select({ sortOrder: plans.sortOrder })
		.from(plans)
		.orderBy(desc(plans.sortOrder))
		.limit(1)
		.get();
	return (latestPlan?.sortOrder ?? 0) + 10;
}

async function assertPlanSortOrderAvailable(env: Env, sortOrder: number, exceptPlanId?: string): Promise<void> {
	const db = getDb(env);
	const duplicate = await db
		.select({ id: plans.id })
		.from(plans)
		.where(exceptPlanId ? and(eq(plans.sortOrder, sortOrder), ne(plans.id, exceptPlanId)) : eq(plans.sortOrder, sortOrder))
		.get();
	if (duplicate) throw apiError(400, 'PLAN_SORT_ORDER_ALREADY_EXISTS');
}

function rethrowPlanSortOrderError(error: unknown): never {
	if (String(error).includes('plans_sort_order_idx')) throw apiError(400, 'PLAN_SORT_ORDER_ALREADY_EXISTS');
	throw error;
}

app.post(
	'/suspend-user',
	describeRoute(omitResAndReq(apiDef['/api/admin/suspend-user'])),
	validator('json', apiDef['/api/admin/suspend-user'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/suspend-user', Env>) => {
		const db = getDb(c.env);
		const adminUser = c.get('user');
		const body = c.req.valid('json');

		if (!body.userId) {
			throw apiError(400, 'USER_ID_IS_REQUIRED');
		}
		if (body.userId === adminUser.id) {
			throw apiError(403, 'FORBIDDEN');
		}

		const user = await db.select().from(users).where(eq(users.id, body.userId)).get();

		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		await db.update(users).set({ isSuspended: true }).where(eq(users.id, body.userId));
		await db.delete(tokens).where(eq(tokens.userId, body.userId));
		await recordModerationAuditLog(c, 'admin_user_suspended', { targetUserId: body.userId });

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
		await recordModerationAuditLog(c, 'admin_user_unsuspended', { targetUserId: body.userId });

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

		const existingAdmin = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.isAdmin, true), ne(users.id, body.userId)))
			.get();
		if (existingAdmin) throw apiError(403, 'FORBIDDEN');

		try {
			await db.update(users).set({ isAdmin: true }).where(eq(users.id, body.userId));
		} catch (error) {
			if (String(error).includes('users_single_admin_idx')) throw apiError(403, 'FORBIDDEN');
			throw error;
		}
		await recordModerationAuditLog(c, 'admin_user_made_admin', { targetUserId: body.userId });

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/make-admin')),
);

app.post(
	'/update-moderator',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-moderator'])),
	validator('json', apiDef['/api/admin/update-moderator'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-moderator', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

		const user = await db.select().from(users).where(eq(users.id, body.userId)).get();
		if (!user) throw apiError(404, 'USER_NOT_FOUND');

		await db.update(users).set({ isModerator: body.isModerator }).where(eq(users.id, body.userId));
		await recordModerationAuditLog(c, 'admin_user_moderator_updated', {
			targetUserId: body.userId,
			data: { isModerator: body.isModerator },
		});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/update-moderator')),
);

app.post(
	'/list-ip-bans',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-ip-bans'])),
	validator('json', apiDef['/api/admin/list-ip-bans'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-ip-bans', Env>) => {
		const db = getDb(c.env);
		const { limit, cursor } = pageParams(c.req.valid('json'));
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
			.where(cursor ? lt(ipBans.id, cursor) : undefined)
			.orderBy(desc(ipBans.id))
			.limit(limit + 1);

		return c.json(idPage(rows, limit, row => ({
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
		await recordModerationAuditLog(c, 'admin_ip_ban_created', {
			data: { banId: id, cidr, reason: row.reason, sourceEventId: row.sourceEventId, expiresAt: row.expiresAt },
		});

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
		await recordModerationAuditLog(c, 'admin_ip_ban_deleted', { data: { banId: body.banId } });
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
		const { limit, cursor } = pageParams(body);
		const fileOwners = alias(users, 'file_owners');
		const whereCondition = body.status && cursor
			? and(eq(fileReports.status, body.status), lt(fileReports.id, cursor))
			: body.status
				? eq(fileReports.status, body.status)
				: cursor
					? lt(fileReports.id, cursor)
					: undefined;
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
				reporterUserId: fileReports.reporterUserId,
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
			.where(whereCondition)
			.orderBy(desc(fileReports.id))
			.limit(limit + 1);

		const rows = await query;
		return c.json(idPage(rows, limit, row => ({
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
				reporterUserId: fileReports.reporterUserId,
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
		await recordModerationAuditLog(c, 'admin_file_report_updated', {
			data: { reportId: body.reportId, status: body.status },
		});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/update-file-report')),
);

app.post(
	'/list-files',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-files'])),
	validator('json', apiDef['/api/admin/list-files'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-files', Env>) => {
		const db = getDb(c.env);
		const { limit, cursor } = pageParams(c.req.valid('json'));
		const rows = await db
			.select({
				id: files.id,
				bucketId: files.bucketId,
				bucketName: buckets.name,
				userId: files.userId,
				ownerUsername: users.username,
				path: files.path,
				size: files.size,
				mimeType: files.mimeType,
				visibility: files.visibility,
				isListed: files.isListed,
				isModerationForcedPrivate: files.isModerationForcedPrivate,
				isClosed: files.isClosed,
				isTargz: files.isTargz,
				isTar: files.isTar,
			})
			.from(files)
			.leftJoin(buckets, eq(files.bucketId, buckets.id))
			.leftJoin(users, eq(files.userId, users.id))
			.where(cursor ? lt(files.id, cursor) : undefined)
			.orderBy(desc(files.id))
			.limit(limit + 1);

		return c.json(idPage(rows, limit, row => ({
			...row,
			createdAt: parseEaidx(row.id).date.getTime(),
		})), 200);
	}, getResponseDefWithAuth('/api/admin/list-files')),
);

app.post(
	'/list-moderation-audit-logs',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-moderation-audit-logs'])),
	validator('json', apiDef['/api/admin/list-moderation-audit-logs'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-moderation-audit-logs', Env>) => {
		const db = getDb(c.env);
		const { limit, cursor } = pageParams(c.req.valid('json'));
		const adminUsers = alias(users, 'admin_users');
		const targetUsers = alias(users, 'target_users');
		const rows = await db
			.select({
				id: moderationAuditLogs.id,
				adminUserId: moderationAuditLogs.adminUserId,
				adminUsername: adminUsers.username,
				action: moderationAuditLogs.action,
				targetFileId: moderationAuditLogs.targetFileId,
				targetUserId: moderationAuditLogs.targetUserId,
				targetUsername: targetUsers.username,
				data: moderationAuditLogs.data,
			})
			.from(moderationAuditLogs)
			.leftJoin(adminUsers, eq(moderationAuditLogs.adminUserId, adminUsers.id))
			.leftJoin(targetUsers, eq(moderationAuditLogs.targetUserId, targetUsers.id))
			.where(cursor ? lt(moderationAuditLogs.id, cursor) : undefined)
			.orderBy(desc(moderationAuditLogs.id))
			.limit(limit + 1);

		return c.json(idPage(rows, limit, row => ({
			...row,
			createdAt: parseEaidx(row.id).date.getTime(),
		})), 200);
	}, getResponseDefWithAuth('/api/admin/list-moderation-audit-logs')),
);

app.post(
	'/update-file-moderation',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-file-moderation'])),
	validator('json', apiDef['/api/admin/update-file-moderation'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-file-moderation', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();
		if (!file) throw apiError(404, 'FILE_NOT_FOUND');

		await db.update(files).set({
			isModerationForcedPrivate: body.isModerationForcedPrivate,
		}).where(eq(files.id, body.fileId));

		const bucket = await db.select({ id: buckets.id, name: buckets.name }).from(buckets).where(eq(buckets.id, file.bucketId)).get();
		if (bucket) {
			fileMutationEvents.emit('file:updated', {
				env: c.env,
				origin: new URL(c.req.url).origin,
				waitUntil: promise => c.executionCtx.waitUntil(promise),
				bucket,
				files: [await toFileMutationReference(db, file)],
			});
		}

		await recordModerationAuditLog(c, 'admin_file_moderation_forced_private_updated', {
			targetFileId: file.id,
			targetUserId: file.userId,
			data: {
				bucketId: file.bucketId,
				bucketName: bucket?.name ?? null,
				path: file.path,
				before: file.isModerationForcedPrivate,
				after: body.isModerationForcedPrivate,
			},
		});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/update-file-moderation')),
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

		await recordModerationAuditLog(c, 'admin_file_deleted', {
			targetFileId: file.id,
			targetUserId: file.userId,
			data: {
				bucketId: file.bucketId,
				bucketName: bucket?.name ?? null,
				path: file.path,
				size: file.size,
			},
		});

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
		await recordModerationAuditLog(c, 'admin_bucket_deleted', {
			targetUserId: bucket.userId,
			data: {
				bucketId: bucket.id,
				bucketName: bucket.name,
				fileCount: bucketFiles.length,
			},
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
		await recordModerationAuditLog(c, 'admin_worker_cache_purged', { data: { version } });
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
				canUseDownloadCount: body.canUseDownloadCount ?? false,
				showAds: body.showAds ?? true,
				canDisableFileAds: body.canDisableFileAds ?? false,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: userQuotas.userId,
				set: {
					maxBuckets: body.maxBuckets ?? null,
					maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
					maxFilesPerBucket: body.maxFilesPerBucket ?? null,
					maxDailyUploads: body.maxDailyUploads ?? null,
					canUseDownloadCount: body.canUseDownloadCount ?? false,
					showAds: body.showAds ?? true,
					canDisableFileAds: body.canDisableFileAds ?? false,
					updatedAt: now,
				},
			});
		await refreshEffectiveQuotaForUser(c.env, userId, now);
		await recordModerationAuditLog(c, 'admin_user_quota_set', {
			targetUserId: userId,
			data: {
				maxBuckets: body.maxBuckets ?? null,
				maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
				maxFilesPerBucket: body.maxFilesPerBucket ?? null,
				maxDailyUploads: body.maxDailyUploads ?? null,
				canUseDownloadCount: body.canUseDownloadCount ?? false,
				showAds: body.showAds ?? true,
				canDisableFileAds: body.canDisableFileAds ?? false,
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

		const quota = {
			maxBuckets: body.maxBuckets ?? null,
			maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
			maxFilesPerBucket: body.maxFilesPerBucket ?? null,
			maxDailyUploads: body.maxDailyUploads ?? null,
			canUseDownloadCount: body.canUseDownloadCount ?? false,
			showAds: body.showAds ?? true,
			canDisableFileAds: body.canDisableFileAds ?? false,
		};

		await db
			.insert(globalQuotas)
			.values({
				key: 'default',
				...quota,
			})
			.onConflictDoUpdate({
				target: globalQuotas.key,
				set: quota,
			});
		await refreshEffectiveQuotaForGlobalFallbackUsers(c.env, quota);
		await recordModerationAuditLog(c, 'admin_global_quota_set', {
			data: quota,
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
	'/get-user-effective-quota',
	describeRoute(omitResAndReq(apiDef['/api/admin/get-user-effective-quota'])),
	validator('json', apiDef['/api/admin/get-user-effective-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/get-user-effective-quota', Env>) => {
		const body = c.req.valid('json');
		const quota = await getStoredEffectiveQuotaForUser(c.env, body.userId);
		if (!quota) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		return c.json(quota, 200);
	}, getResponseDefWithAuth('/api/admin/get-user-effective-quota')),
);

app.post(
	'/recalculate-user-effective-quota',
	describeRoute(omitResAndReq(apiDef['/api/admin/recalculate-user-effective-quota'])),
	validator('json', apiDef['/api/admin/recalculate-user-effective-quota'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/recalculate-user-effective-quota', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const user = await db.select({ id: users.id }).from(users).where(eq(users.id, body.userId)).get();
		if (!user) {
			throw apiError(404, 'USER_NOT_FOUND');
		}

		const quota = await refreshEffectiveQuotaForUser(c.env, body.userId);
		await recordModerationAuditLog(c, 'admin_user_quota_recalculated', {
			targetUserId: body.userId,
			data: {
				maxBuckets: quota.maxBuckets,
				maxBucketSizeBytes: quota.maxBucketSizeBytes,
				maxFilesPerBucket: quota.maxFilesPerBucket,
				maxDailyUploads: quota.maxDailyUploads,
				canUseDownloadCount: quota.canUseDownloadCount,
				showAds: quota.showAds,
				canDisableFileAds: quota.canDisableFileAds,
				effectiveQuotaExpiresAt: quota.effectiveQuotaExpiresAt,
				effectiveQuotaSource: quota.effectiveQuotaSource,
			},
		});
		return c.json(quota, 200);
	}, getResponseDefWithAuth('/api/admin/recalculate-user-effective-quota')),
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
				canUseDownloadCount: userQuota?.canUseDownloadCount ?? false,
				showAds: userQuota?.showAds ?? true,
				canDisableFileAds: userQuota?.canDisableFileAds ?? false,
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
		await refreshEffectiveQuotaForUser(c.env, body.userId);
		await recordModerationAuditLog(c, 'admin_user_quota_deleted', { targetUserId: body.userId });

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-user-quota')),
);

app.post(
	'/list-users',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-users'])),
	validator('json', apiDef['/api/admin/list-users'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-users', Env>) => {
		const db = getDb(c.env);
		const { limit, cursor } = pageParams(c.req.valid('json'));
		const allUsers = await db.select({
			id: users.id,
			username: users.username,
			isAdmin: users.isAdmin,
			isModerator: users.isModerator,
			isSuspended: users.isSuspended,
		})
			.from(users)
			.where(cursor ? lt(users.id, cursor) : undefined)
			.orderBy(desc(users.id))
			.limit(limit + 1);
		return c.json(idPage(allUsers, limit, user => user), 200);
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
		await recordModerationAuditLog(c, 'admin_setting_updated', {
			data: { key: body.key, value: body.value },
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
		const allPlans = await db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.createdAt), asc(plans.id)).all();
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
		const sortOrder = body.sortOrder ?? await getNextPlanSortOrder(c.env);
		await assertPlanSortOrderAvailable(c.env, sortOrder);
		const plan = {
			id: genEaidx(now),
			name: body.name,
			maxBuckets: body.maxBuckets ?? null,
			maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
			maxFilesPerBucket: body.maxFilesPerBucket ?? null,
			maxDailyUploads: body.maxDailyUploads ?? null,
			canUseDownloadCount: body.canUseDownloadCount ?? false,
			showAds: body.showAds ?? true,
			canDisableFileAds: body.canDisableFileAds ?? false,
			isEnabled: body.isEnabled,
			sortOrder,
			createdAt: now,
			updatedAt: now,
		};

		try {
			await db.insert(plans).values(plan);
		} catch (error) {
			rethrowPlanSortOrderError(error);
		}
		await recordModerationAuditLog(c, 'admin_plan_created', {
			data: { planId: plan.id, name: plan.name },
		});

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

		const sortOrder = body.sortOrder ?? existing.sortOrder;
		await assertPlanSortOrderAvailable(c.env, sortOrder, body.planId);
		const updated = {
			id: existing.id,
			name: body.name,
			maxBuckets: body.maxBuckets ?? null,
			maxBucketSizeBytes: body.maxBucketSizeBytes ?? null,
			maxFilesPerBucket: body.maxFilesPerBucket ?? null,
			maxDailyUploads: body.maxDailyUploads ?? null,
			canUseDownloadCount: body.canUseDownloadCount ?? false,
			showAds: body.showAds ?? true,
			canDisableFileAds: body.canDisableFileAds ?? false,
			isEnabled: body.isEnabled,
			sortOrder,
			createdAt: existing.createdAt,
			updatedAt: Date.now(),
		};

		try {
			await db.update(plans).set({
				name: updated.name,
				maxBuckets: updated.maxBuckets,
				maxBucketSizeBytes: updated.maxBucketSizeBytes,
				maxFilesPerBucket: updated.maxFilesPerBucket,
				maxDailyUploads: updated.maxDailyUploads,
				canUseDownloadCount: updated.canUseDownloadCount,
				showAds: updated.showAds,
				canDisableFileAds: updated.canDisableFileAds,
				isEnabled: updated.isEnabled,
				sortOrder: updated.sortOrder,
				updatedAt: updated.updatedAt,
			}).where(eq(plans.id, body.planId));
		} catch (error) {
			rethrowPlanSortOrderError(error);
		}
		await refreshEffectiveQuotaForPlanUsers(c.env, body.planId, updated.updatedAt);
		await recordModerationAuditLog(c, 'admin_plan_updated', {
			data: { planId: body.planId, name: updated.name },
		});

		return c.json(updated, 200);
	}, getResponseDefWithAuth('/api/admin/update-plan')),
);

app.post(
	'/assign-user-plan',
	describeRoute(omitResAndReq(apiDef['/api/admin/assign-user-plan'])),
	validator('json', apiDef['/api/admin/assign-user-plan'].req),
	describeResponse(async () => {
		throw apiError(400, 'MANUAL_PLAN_ASSIGNMENT_NOT_SUPPORTED');
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
			.orderBy(
				desc(sql<number>`case when ${userPlanAssignments.startsAt} <= ${Date.now()} and ${userPlanAssignments.expiresAt} > ${Date.now()} then 1 else 0 end`),
				desc(userPlanAssignments.startsAt),
				desc(userPlanAssignments.expiresAt),
			)
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
		await refreshEffectiveQuotaForUser(c.env, body.userId);
		await recordModerationAuditLog(c, 'admin_user_plan_deleted', { targetUserId: body.userId });

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-user-plan')),
);

export const adminRoutes = app;
