import { index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const plans = sqliteTable('plans', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	maxBuckets: integer('max_buckets'),
	maxBucketSizeBytes: integer('max_bucket_size_bytes'),
	maxFilesPerBucket: integer('max_files_per_bucket'),
	maxDailyUploads: integer('max_daily_uploads'),
	canUseDownloadCount: integer('can_use_download_count', { mode: 'boolean' }).notNull().default(false),
	showAds: integer('show_ads', { mode: 'boolean' }).notNull().default(true),
	canDisableFileAds: integer('can_disable_file_ads', { mode: 'boolean' }).notNull().default(false),
	isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
	sortOrder: integer('sort_order').notNull().default(0),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
}, (table) => [
	uniqueIndex('plans_sort_order_idx').on(table.sortOrder),
]);

export const userPlanAssignments = sqliteTable('user_plan_assignments', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
	startsAt: integer('starts_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	priceAssetId: text('price_asset_id').notNull(),
	priceAmountBaseUnits: text('price_amount_base_units').notNull(),
	priceDurationDays: integer('price_duration_days').notNull(),
	priceDurationUnit: text('price_duration_unit', { enum: ['days', 'months', 'years'] }).notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	refundProvenanceComplete: integer('refund_provenance_complete', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
	index('user_plan_assignments_user_period_idx').on(table.userId, table.startsAt, table.expiresAt),
	index('user_plan_assignments_plan_id_idx').on(table.planId),
]);

export const userQuotas = sqliteTable('user_quotas', {
	userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
	maxBuckets: integer('max_buckets'),
	maxBucketSizeBytes: integer('max_bucket_size_bytes'),
	maxFilesPerBucket: integer('max_files_per_bucket'),
	maxDailyUploads: integer('max_daily_uploads'),
	canUseDownloadCount: integer('can_use_download_count', { mode: 'boolean' }).notNull().default(false),
	showAds: integer('show_ads', { mode: 'boolean' }).notNull().default(true),
	canDisableFileAds: integer('can_disable_file_ads', { mode: 'boolean' }).notNull().default(false),
	updatedAt: integer('updated_at').notNull(),
});

export const globalQuotas = sqliteTable('global_quotas', {
	key: text('key').primaryKey(),
	maxBuckets: integer('max_buckets'),
	maxBucketSizeBytes: integer('max_bucket_size_bytes'),
	maxFilesPerBucket: integer('max_files_per_bucket'),
	maxDailyUploads: integer('max_daily_uploads'),
	canUseDownloadCount: integer('can_use_download_count', { mode: 'boolean' }).notNull().default(false),
	showAds: integer('show_ads', { mode: 'boolean' }).notNull().default(true),
	canDisableFileAds: integer('can_disable_file_ads', { mode: 'boolean' }).notNull().default(false),
});
