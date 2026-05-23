import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash'),
	googleId: text('google_id').unique(),
	misskeyId: text('misskey_id').unique(),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	isSuspended: integer('is_suspended', { mode: 'boolean' }).notNull().default(false),
	termsAgreedAt: integer('terms_agreed_at'),
});

export const tokens = sqliteTable('tokens', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	token: text('token').notNull().unique(),
	reauthenticatedAt: integer('reauthenticated_at'),
});

export const oauthStates = sqliteTable('oauth_states', {
	id: text('id').primaryKey(),
	state: text('state').notNull().unique(),
	codeVerifier: text('code_verifier'),
	profileUrl: text('profile_url'),
	linkUserId: text('link_user_id').references(() => users.id, { onDelete: 'cascade' }),
	signupPassphrase: text('signup_passphrase'),
	signupUsername: text('signup_username'),
	expiresAt: integer('expires_at').notNull(),
});
