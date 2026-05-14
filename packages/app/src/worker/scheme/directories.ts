import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { buckets } from './buckets';

export const directories = sqliteTable('directories', {
	id: text('id').primaryKey(),
	bucketId: text('bucket_id').notNull().references(() => buckets.id, { onDelete: 'cascade' }),
	path: text('path').notNull(), // always ends with "/"
}, (table) => [
	uniqueIndex('directories_bucket_path_idx').on(table.bucketId, table.path),
]);
