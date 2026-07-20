import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { buckets, userQuotas, globalQuotas, userPlanAssignments, plans, users } from '../scheme/index';
import { getDb } from './db';
import { reserveEmailNotification, sendAccountEmailLines } from './email';
import { getAppName } from './app-name';
import { runBackgroundTask, type WaitUntil } from './background-task';

export interface RateLimitConfig {
	maxBuckets: number | null;
	maxBucketSizeBytes: number | null;
	maxFilesPerBucket: number | null;
	maxDailyUploads: number | null;
	canUseDownloadCount: boolean;
	showAds: boolean;
	canDisableFileAds: boolean;
}

export type EffectiveQuotaSource = 'plan' | 'custom' | 'global' | 'default';

export interface EffectiveQuotaConfig extends RateLimitConfig {
	effectiveQuotaExpiresAt: number | null;
	effectiveQuotaUpdatedAt: number;
	effectiveQuotaSource: EffectiveQuotaSource;
}

export interface StoredEffectiveQuotaConfig extends RateLimitConfig {
	effectiveQuotaExpiresAt: number | null;
	effectiveQuotaUpdatedAt: number | null;
	effectiveQuotaSource: EffectiveQuotaSource | null;
}

async function sendQuotaExceededAfterPlanEndNotification(env: Env, options: {
	userId: string;
	previousPlanExpiresAt: number;
	maxBucketSizeBytes: number;
	now: number;
}): Promise<void> {
	const exceededBuckets = await getDb(env)
		.select({ name: buckets.name, usedBytes: buckets.usedBytes })
		.from(buckets)
		.where(and(eq(buckets.userId, options.userId)));
	const exceeded = exceededBuckets.filter(bucket => bucket.usedBytes > options.maxBucketSizeBytes);
	if (exceeded.length === 0) return;
	const eventKey = `quota-exceeded:${options.previousPlanExpiresAt}:${options.maxBucketSizeBytes}`;
	if (!await reserveEmailNotification(env, options.userId, 'quota_exceeded', eventKey, options.now)) return;
	const appName = await getAppName(env);
	await sendAccountEmailLines(env, options.userId, `${appName} 保存容量超過のお知らせ`, [
		'上位プランの期間終了により、現在の保存容量が新しい上限を超えています。',
		'',
		`プラン終了日時: ${new Date(options.previousPlanExpiresAt).toISOString()}`,
		`現在のバケット容量上限: ${formatBytes(options.maxBucketSizeBytes)}`,
		'',
		...exceeded.map(bucket => `- ${bucket.name}: ${formatBytes(bucket.usedBytes)}`),
		'',
		'ファイルを整理するか、必要に応じてプランを購入してください。',
	]);
}

const defaultQuota: RateLimitConfig = {
	maxBuckets: null,
	maxBucketSizeBytes: null,
	maxFilesPerBucket: null,
	maxDailyUploads: null,
	canUseDownloadCount: false,
	showAds: true,
	canDisableFileAds: false,
};

function withMetadata(
	quota: RateLimitConfig,
	now: number,
	effectiveQuotaExpiresAt: number | null,
	effectiveQuotaSource: EffectiveQuotaSource,
): EffectiveQuotaConfig {
	return {
		...quota,
		effectiveQuotaExpiresAt,
		effectiveQuotaUpdatedAt: now,
		effectiveQuotaSource,
	};
}

function toRateLimitConfig(quota: EffectiveQuotaConfig): RateLimitConfig {
	return {
		maxBuckets: quota.maxBuckets,
		maxBucketSizeBytes: quota.maxBucketSizeBytes,
		maxFilesPerBucket: quota.maxFilesPerBucket,
		maxDailyUploads: quota.maxDailyUploads,
		canUseDownloadCount: quota.canUseDownloadCount,
		showAds: quota.showAds,
		canDisableFileAds: quota.canDisableFileAds,
	};
}

function toStoredEffectiveQuotaConfig(user: {
	effectiveMaxBuckets: number | null;
	effectiveMaxBucketSizeBytes: number | null;
	effectiveMaxFilesPerBucket: number | null;
	effectiveMaxDailyUploads: number | null;
	effectiveCanUseDownloadCount: boolean;
	effectiveShowAds: boolean;
	effectiveCanDisableFileAds: boolean;
	effectiveQuotaExpiresAt: number | null;
	effectiveQuotaUpdatedAt: number | null;
	effectiveQuotaSource: string | null;
}): StoredEffectiveQuotaConfig {
	const source = user.effectiveQuotaSource;
	return {
		maxBuckets: user.effectiveMaxBuckets,
		maxBucketSizeBytes: user.effectiveMaxBucketSizeBytes,
		maxFilesPerBucket: user.effectiveMaxFilesPerBucket,
		maxDailyUploads: user.effectiveMaxDailyUploads,
		canUseDownloadCount: user.effectiveCanUseDownloadCount,
		showAds: user.effectiveShowAds,
		canDisableFileAds: user.effectiveCanDisableFileAds,
		effectiveQuotaExpiresAt: user.effectiveQuotaExpiresAt,
		effectiveQuotaUpdatedAt: user.effectiveQuotaUpdatedAt,
		effectiveQuotaSource: source === 'plan' || source === 'custom' || source === 'global' || source === 'default' ? source : null,
	};
}

function toUserQuotaUpdate(quota: EffectiveQuotaConfig) {
	return {
		effectiveMaxBuckets: quota.maxBuckets,
		effectiveMaxBucketSizeBytes: quota.maxBucketSizeBytes,
		effectiveMaxFilesPerBucket: quota.maxFilesPerBucket,
		effectiveMaxDailyUploads: quota.maxDailyUploads,
		effectiveCanUseDownloadCount: quota.canUseDownloadCount,
		effectiveShowAds: quota.showAds,
		effectiveCanDisableFileAds: quota.canDisableFileAds,
		effectiveQuotaExpiresAt: quota.effectiveQuotaExpiresAt,
		effectiveQuotaUpdatedAt: quota.effectiveQuotaUpdatedAt,
		effectiveQuotaSource: quota.effectiveQuotaSource,
	};
}

async function computeEffectiveQuotaForUser(env: Env, userId: string, now: number): Promise<EffectiveQuotaConfig> {
	const db = getDb(env);

	const userQuota = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId)).get();

	if (userQuota) {
		return withMetadata({
			maxBuckets: userQuota.maxBuckets,
			maxBucketSizeBytes: userQuota.maxBucketSizeBytes,
			maxFilesPerBucket: userQuota.maxFilesPerBucket,
			maxDailyUploads: userQuota.maxDailyUploads,
			canUseDownloadCount: userQuota.canUseDownloadCount,
			showAds: userQuota.showAds,
			canDisableFileAds: userQuota.canDisableFileAds,
		}, now, null, 'custom');
	}

	const activePlan = await db
		.select({
			maxBuckets: plans.maxBuckets,
			maxBucketSizeBytes: plans.maxBucketSizeBytes,
			maxFilesPerBucket: plans.maxFilesPerBucket,
			maxDailyUploads: plans.maxDailyUploads,
			canUseDownloadCount: plans.canUseDownloadCount,
			showAds: plans.showAds,
			canDisableFileAds: plans.canDisableFileAds,
			expiresAt: userPlanAssignments.expiresAt,
		})
		.from(userPlanAssignments)
		.innerJoin(plans, eq(userPlanAssignments.planId, plans.id))
		.where(and(
			eq(userPlanAssignments.userId, userId),
			lt(userPlanAssignments.startsAt, now + 1),
			gt(userPlanAssignments.expiresAt, now),
		))
		.orderBy(desc(plans.sortOrder), desc(userPlanAssignments.expiresAt))
		.get();

	if (activePlan) {
		return withMetadata({
			maxBuckets: activePlan.maxBuckets,
			maxBucketSizeBytes: activePlan.maxBucketSizeBytes,
			maxFilesPerBucket: activePlan.maxFilesPerBucket,
			maxDailyUploads: activePlan.maxDailyUploads,
			canUseDownloadCount: activePlan.canUseDownloadCount,
			showAds: activePlan.showAds,
			canDisableFileAds: activePlan.canDisableFileAds,
		}, now, activePlan.expiresAt, 'plan');
	}

	return getGlobalEffectiveQuota(env, now);
}

async function getGlobalEffectiveQuota(env: Env, now: number): Promise<EffectiveQuotaConfig> {
	const db = getDb(env);

	const globalQuota = await db
		.select()
		.from(globalQuotas)
		.where(eq(globalQuotas.key, 'default'))
		.get();

	if (globalQuota) {
		return withMetadata({
			maxBuckets: globalQuota.maxBuckets,
			maxBucketSizeBytes: globalQuota.maxBucketSizeBytes,
			maxFilesPerBucket: globalQuota.maxFilesPerBucket,
			maxDailyUploads: globalQuota.maxDailyUploads,
			canUseDownloadCount: globalQuota.canUseDownloadCount,
			showAds: globalQuota.showAds,
			canDisableFileAds: globalQuota.canDisableFileAds,
		}, now, null, 'global');
	}

	return withMetadata(defaultQuota, now, null, 'default');
}

export async function getInitialEffectiveQuotaForUser(env: Env, now = Date.now()): Promise<EffectiveQuotaConfig> {
	return getGlobalEffectiveQuota(env, now);
}

export async function refreshEffectiveQuotaForUser(env: Env, userId: string, now = Date.now(), waitUntil?: WaitUntil): Promise<EffectiveQuotaConfig> {
	const db = getDb(env);
	const previous = await db
		.select({
			effectiveQuotaSource: users.effectiveQuotaSource,
			effectiveQuotaExpiresAt: users.effectiveQuotaExpiresAt,
		})
		.from(users)
		.where(eq(users.id, userId))
		.get();
	const quota = await computeEffectiveQuotaForUser(env, userId, now);

	await db
		.update(users)
		.set(toUserQuotaUpdate(quota))
		.where(eq(users.id, userId));

	if (
		previous?.effectiveQuotaSource === 'plan'
		&& previous.effectiveQuotaExpiresAt !== null
		&& previous.effectiveQuotaExpiresAt <= now
		&& quota.maxBucketSizeBytes !== null
	) {
		runBackgroundTask(waitUntil, sendQuotaExceededAfterPlanEndNotification(env, {
			userId,
			previousPlanExpiresAt: previous.effectiveQuotaExpiresAt,
			maxBucketSizeBytes: quota.maxBucketSizeBytes,
			now,
		}), 'Failed to send quota exceeded notification:');
	}

	return quota;
}

export async function refreshEffectiveQuotaForPlanUsers(env: Env, planId: string, now = Date.now()): Promise<void> {
	const db = getDb(env);
	const assignedUsers = await db
		.select({ userId: userPlanAssignments.userId })
		.from(userPlanAssignments)
		.where(eq(userPlanAssignments.planId, planId));

	for (const assignedUser of assignedUsers) {
		await refreshEffectiveQuotaForUser(env, assignedUser.userId, now);
	}
}

export async function refreshEffectiveQuotaForGlobalFallbackUsers(env: Env, quota: RateLimitConfig, now = Date.now()): Promise<void> {
	const db = getDb(env);

	await db
		.update(users)
		.set(toUserQuotaUpdate(withMetadata(quota, now, null, 'global')))
		.where(sql`
			not exists (
				select 1 from ${userQuotas}
				where ${userQuotas.userId} = ${users.id}
			)
			and not exists (
				select 1 from ${userPlanAssignments}
				where ${userPlanAssignments.userId} = ${users.id}
				and ${userPlanAssignments.startsAt} <= ${now}
				and ${userPlanAssignments.expiresAt} > ${now}
			)
		`);
}

export async function getQuotaForUser(env: Env, userId: string): Promise<RateLimitConfig> {
	return toRateLimitConfig(await getEffectiveQuotaForUser(env, userId));
}

export async function getEffectiveQuotaForUser(env: Env, userId: string): Promise<EffectiveQuotaConfig> {
	const db = getDb(env);
	const now = Date.now();

	const user = await db
		.select({
			effectiveMaxBuckets: users.effectiveMaxBuckets,
			effectiveMaxBucketSizeBytes: users.effectiveMaxBucketSizeBytes,
			effectiveMaxFilesPerBucket: users.effectiveMaxFilesPerBucket,
			effectiveMaxDailyUploads: users.effectiveMaxDailyUploads,
			effectiveCanUseDownloadCount: users.effectiveCanUseDownloadCount,
			effectiveShowAds: users.effectiveShowAds,
			effectiveCanDisableFileAds: users.effectiveCanDisableFileAds,
			effectiveQuotaExpiresAt: users.effectiveQuotaExpiresAt,
			effectiveQuotaUpdatedAt: users.effectiveQuotaUpdatedAt,
			effectiveQuotaSource: users.effectiveQuotaSource,
		})
		.from(users)
		.where(eq(users.id, userId))
		.get();
	const source = user?.effectiveQuotaSource;

	if (
		!user
		|| user.effectiveQuotaUpdatedAt === null
		|| !(source === 'plan' || source === 'custom' || source === 'global' || source === 'default')
		|| (user.effectiveQuotaExpiresAt !== null && user.effectiveQuotaExpiresAt <= now)
	) {
		return refreshEffectiveQuotaForUser(env, userId, now);
	}

	return {
		maxBuckets: user.effectiveMaxBuckets,
		maxBucketSizeBytes: user.effectiveMaxBucketSizeBytes,
		maxFilesPerBucket: user.effectiveMaxFilesPerBucket,
		maxDailyUploads: user.effectiveMaxDailyUploads,
		canUseDownloadCount: user.effectiveCanUseDownloadCount,
		showAds: user.effectiveShowAds,
		canDisableFileAds: user.effectiveCanDisableFileAds,
		effectiveQuotaExpiresAt: user.effectiveQuotaExpiresAt,
		effectiveQuotaUpdatedAt: user.effectiveQuotaUpdatedAt,
		effectiveQuotaSource: source,
	};
}

export async function getStoredEffectiveQuotaForUser(env: Env, userId: string): Promise<StoredEffectiveQuotaConfig | null> {
	const db = getDb(env);
	const user = await db
		.select({
			effectiveMaxBuckets: users.effectiveMaxBuckets,
			effectiveMaxBucketSizeBytes: users.effectiveMaxBucketSizeBytes,
			effectiveMaxFilesPerBucket: users.effectiveMaxFilesPerBucket,
			effectiveMaxDailyUploads: users.effectiveMaxDailyUploads,
			effectiveCanUseDownloadCount: users.effectiveCanUseDownloadCount,
			effectiveShowAds: users.effectiveShowAds,
			effectiveCanDisableFileAds: users.effectiveCanDisableFileAds,
			effectiveQuotaExpiresAt: users.effectiveQuotaExpiresAt,
			effectiveQuotaUpdatedAt: users.effectiveQuotaUpdatedAt,
			effectiveQuotaSource: users.effectiveQuotaSource,
		})
		.from(users)
		.where(eq(users.id, userId))
		.get();

	return user ? toStoredEffectiveQuotaConfig(user) : null;
}

export async function getGlobalQuota(env: Env): Promise<RateLimitConfig> {
	const db = getDb(env);

	const globalQuota = await db
		.select()
		.from(globalQuotas)
		.where(eq(globalQuotas.key, 'default'))
		.get();

	if (globalQuota) {
		return {
			maxBuckets: globalQuota.maxBuckets,
			maxBucketSizeBytes: globalQuota.maxBucketSizeBytes,
			maxFilesPerBucket: globalQuota.maxFilesPerBucket,
			maxDailyUploads: globalQuota.maxDailyUploads,
			canUseDownloadCount: globalQuota.canUseDownloadCount,
			showAds: globalQuota.showAds,
			canDisableFileAds: globalQuota.canDisableFileAds,
		};
	}

	return defaultQuota;
}

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
	return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}
