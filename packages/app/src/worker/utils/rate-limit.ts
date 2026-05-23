import { and, eq, gt } from 'drizzle-orm';
import { userQuotas, globalQuotas, userPlanAssignments, plans } from '../scheme/index';
import { getDb } from './db';

export interface RateLimitConfig {
	maxBuckets: number | null;
	maxBucketSizeBytes: number | null;
	maxFilesPerBucket: number | null;
	maxDailyUploads: number | null;
}

export async function getQuotaForUser(env: Env, userId: string): Promise<RateLimitConfig> {
	const db = getDb(env);
	const now = Date.now();

	const activePlan = await db
		.select({
			maxBuckets: plans.maxBuckets,
			maxBucketSizeBytes: plans.maxBucketSizeBytes,
			maxFilesPerBucket: plans.maxFilesPerBucket,
			maxDailyUploads: plans.maxDailyUploads,
		})
		.from(userPlanAssignments)
		.innerJoin(plans, eq(userPlanAssignments.planId, plans.id))
		.where(and(
			eq(userPlanAssignments.userId, userId),
			gt(userPlanAssignments.expiresAt, now),
		))
		.get();

	if (activePlan) {
		return {
			maxBuckets: activePlan.maxBuckets,
			maxBucketSizeBytes: activePlan.maxBucketSizeBytes,
			maxFilesPerBucket: activePlan.maxFilesPerBucket,
			maxDailyUploads: activePlan.maxDailyUploads,
		};
	}

	const userQuota = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId)).get();

	if (userQuota) {
		return {
			maxBuckets: userQuota.maxBuckets,
			maxBucketSizeBytes: userQuota.maxBucketSizeBytes,
			maxFilesPerBucket: userQuota.maxFilesPerBucket,
			maxDailyUploads: userQuota.maxDailyUploads,
		};
	}

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
		};
	}

	return {
		maxBuckets: null,
		maxBucketSizeBytes: null,
		maxFilesPerBucket: null,
		maxDailyUploads: null,
	};
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
		};
	}

	return {
		maxBuckets: null,
		maxBucketSizeBytes: null,
		maxFilesPerBucket: null,
		maxDailyUploads: null,
	};
}
