import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const plans = sqliteTable('plans', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	maxBuckets: integer('max_buckets'),
	maxBucketSizeBytes: integer('max_bucket_size_bytes'),
	maxFilesPerBucket: integer('max_files_per_bucket'),
	maxDailyUploads: integer('max_daily_uploads'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
});

export const userPlanAssignments = sqliteTable('user_plan_assignments', {
	userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
	planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
	expiresAt: integer('expires_at').notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
});

export const userQuotas = sqliteTable('user_quotas', {
	userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
	maxBuckets: integer('max_buckets'),
	maxBucketSizeBytes: integer('max_bucket_size_bytes'),
	maxFilesPerBucket: integer('max_files_per_bucket'),
	maxDailyUploads: integer('max_daily_uploads'),
	updatedAt: integer('updated_at').notNull(),
});

export const globalQuotas = sqliteTable('global_quotas', {
	key: text('key').primaryKey(),
	maxBuckets: integer('max_buckets'),
	maxBucketSizeBytes: integer('max_bucket_size_bytes'),
	maxFilesPerBucket: integer('max_files_per_bucket'),
	maxDailyUploads: integer('max_daily_uploads'),
});
