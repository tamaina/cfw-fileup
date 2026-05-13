import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const buckets = sqliteTable('buckets', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull().unique(),
	createdAt: integer('created_at').notNull(),
});
