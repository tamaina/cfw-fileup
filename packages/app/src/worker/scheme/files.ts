import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { buckets } from './buckets';
import { users } from './users';
import { binaryBlob } from './binary-blob';

export const files = sqliteTable('files', {
	id: text('id').primaryKey(),
	bucketId: text('bucket_id').notNull().references(() => buckets.id, { onDelete: 'cascade' }),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	path: text('path').notNull(),
	r2Key: text('r2_key').notNull().unique(),
	size: integer('size'),
	mimeType: text('mime_type'),
	visibility: text('visibility', { enum: ['public', 'private', 'passphrase'] }).notNull().default('public'),
	isListed: integer('is_listed', { mode: 'boolean' }).notNull().default(true),
	isModerationForcedPrivate: integer('is_moderation_forced_private', { mode: 'boolean' }).notNull().default(false),
	downloadCount: integer('download_count').notNull().default(0),
	isDownloadCountEnabled: integer('is_download_count_enabled', { mode: 'boolean' }).notNull().default(false),
	isDownloadCountVisible: integer('is_download_count_visible', { mode: 'boolean' }).notNull().default(false),
	passphraseHash: binaryBlob('passphrase_hash'),
	uploadExpiresAt: integer('upload_expires_at').notNull(),
	isClosed: integer('is_closed', { mode: 'boolean' }).notNull().default(false),
	isTargz: integer('is_targz', { mode: 'boolean' }).notNull().default(false),
	isTar: integer('is_tar', { mode: 'boolean' }).notNull().default(false),
	/** クライアントサイドE2E暗号化（AES-256-CTR）が適用されているか */
	isEncrypted: integer('is_encrypted', { mode: 'boolean' }).notNull().default(false),
	uploadId: text('upload_id'),
	/** マルチパートアップロードのパートサイズ（バイト）。デフォルト32MiB */
	partSize: integer('part_size').notNull().default(32 * 1024 * 1024),
}, (table) => [
	uniqueIndex('files_bucket_path_idx').on(table.bucketId, table.path),
	index('files_user_id_id_idx').on(table.userId, table.id),
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
}, (table) => [
	uniqueIndex('targz_files_file_id_path_idx').on(table.fileId, table.path),
]);

export const tarFiles = sqliteTable('tar_files', {
	id: text('id').primaryKey(),
	fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
	path: text('path').notNull(),
	mimeType: text('mime_type').notNull(),
	offset: integer('offset').notNull(),
	size: integer('size').notNull(),
}, (table) => [
	uniqueIndex('tar_files_file_id_path_idx').on(table.fileId, table.path),
]);

export const uploadParts = sqliteTable('upload_parts', {
	id: text('id').primaryKey(),
	fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
	partNumber: integer('part_number').notNull(),
	etag: text('etag').notNull(),
}, (table) => [
	uniqueIndex('upload_parts_file_part_idx').on(table.fileId, table.partNumber),
]);

/** デフォルトのパートサイズ: 32MiB
 * R2のマルチパートアップロードはパートごとにClass A操作となるため、
 * コストを抑えるためにパートサイズを大きく設定する。
 */
export const DEFAULT_PART_SIZE = 32 * 1024 * 1024;

/** R2マルチパートアップロードの最小パートサイズ: 5MiB */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
