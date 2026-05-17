import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const passkeys = sqliteTable('passkeys', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	credentialId: text('credential_id').notNull().unique(),
	publicKey: text('public_key').notNull(),
	counter: integer('counter').notNull().default(0),
	transports: text('transports'), // JSON array string
	createdAt: integer('created_at').notNull(),
});

export const passkeysChallenges = sqliteTable('passkeys_challenges', {
	id: text('id').primaryKey(),
	challenge: text('challenge').notNull(),
	userId: text('user_id'), // null for authentication (before we know which user)
	type: text('type').notNull(), // 'register' | 'authenticate'
	expiresAt: integer('expires_at').notNull(),
});
