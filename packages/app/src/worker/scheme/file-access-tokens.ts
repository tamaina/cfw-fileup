import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { files } from './files';

export const fileAccessTokens = sqliteTable('file_access_tokens', {
	id: text('id').primaryKey(),
	fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
	token: text('token').notNull().unique(),
	expiresAt: integer('expires_at'),
});
