import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const misskeyAccounts = sqliteTable('misskey_accounts', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	misskeyId: text('misskey_id').notNull().unique(),
	issuer: text('issuer').notNull(),
	username: text('username'),
	name: text('name'),
	createdAt: integer('created_at').notNull(),
});
