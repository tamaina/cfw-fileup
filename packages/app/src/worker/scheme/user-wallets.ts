import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const userWallets = sqliteTable('user_wallets', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	chainId: integer('chain_id').notNull(),
	address: text('address').notNull(),
	label: text('label'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
}, (table) => [
	index('user_wallets_user_id_idx').on(table.userId),
	uniqueIndex('user_wallets_chain_address_idx').on(table.chainId, table.address),
]);

export const walletLinkChallenges = sqliteTable('wallet_link_challenges', {
	nonce: text('nonce').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	chainId: integer('chain_id').notNull(),
	address: text('address').notNull(),
	domain: text('domain').notNull(),
	uri: text('uri').notNull(),
	message: text('message').notNull(),
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	usedAt: integer('used_at'),
}, (table) => [
	index('wallet_link_challenges_user_id_idx').on(table.userId),
	index('wallet_link_challenges_expires_at_idx').on(table.expiresAt),
]);
