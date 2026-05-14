import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { buckets } from './buckets';

export const files = sqliteTable('files', {
	id: text('id').primaryKey(),
	bucketId: text('bucket_id').notNull().references(() => buckets.id, { onDelete: 'cascade' }),
	path: text('path').notNull(),
	r2Key: text('r2_key').notNull().unique(),
	size: integer('size'),
	mimeType: text('mime_type'),
	isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(true),
	passphrase: text('passphrase'),
	uploadExpiresAt: integer('upload_expires_at').notNull(),
	isClosed: integer('is_closed', { mode: 'boolean' }).notNull().default(false),
	isTargz: integer('is_targz', { mode: 'boolean' }).notNull().default(false),
	isTar: integer('is_tar', { mode: 'boolean' }).notNull().default(false),
	uploadId: text('upload_id'),
	createdAt: integer('created_at').notNull(),
}, (table) => [
	uniqueIndex('files_bucket_path_idx').on(table.bucketId, table.path),
]);

export const targzFiles = sqliteTable('targz_files', {
	id: text('id').primaryKey(),
	fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
	path: text('path').notNull(),
	mimeType: text('mime_type').notNull(),
	aStart: integer('a_start').notNull(),
	aFirstEnd: integer('a_first_end').notNull(),
	aFinalStart: integer('a_final_start').notNull(),
	aEnd: integer('a_end').notNull(),
	rStartOffset: integer('r_start_offset').notNull(),
	rEndOffset: integer('r_end_offset').notNull(),
});

export const tarFiles = sqliteTable('tar_files', {
	id: text('id').primaryKey(),
	fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
	path: text('path').notNull(),
	mimeType: text('mime_type').notNull(),
	offset: integer('offset').notNull(),
	size: integer('size').notNull(),
});

export const uploadParts = sqliteTable('upload_parts', {
	id: text('id').primaryKey(),
	fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
	partNumber: integer('part_number').notNull(),
	etag: text('etag').notNull(),
});
