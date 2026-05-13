import { eq } from 'drizzle-orm';
import { userQuotas, globalQuotas } from '../scheme/index';
import { getDb } from './db';

export interface RateLimitConfig {
	maxBuckets: number | null;
	maxBucketSizeBytes: number | null;
	maxFilesPerBucket: number | null;
	maxDailyUploads: number | null;
}

export async function getQuotaForUser(env: Env, userId: string): Promise<RateLimitConfig> {
	const db = getDb(env);

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
