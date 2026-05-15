import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	isSuspended: integer('is_suspended', { mode: 'boolean' }).notNull().default(false),
	createdAt: integer('created_at').notNull(),
});

export const tokens = sqliteTable('tokens', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	token: text('token').notNull().unique(),
});
