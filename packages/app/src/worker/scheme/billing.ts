import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { plans } from './rate-limits';
import { userWallets } from './user-wallets';
import { users } from './users';

export const paymentChains = sqliteTable('payment_chains', {
	chainId: integer('chain_id').primaryKey(),
	name: text('name').notNull(),
	nativeCurrencyName: text('native_currency_name').notNull(),
	nativeCurrencySymbol: text('native_currency_symbol').notNull(),
	nativeCurrencyDecimals: integer('native_currency_decimals').notNull(),
	blockExplorerUrl: text('block_explorer_url'),
	confirmationsRequired: integer('confirmations_required').notNull().default(1),
	isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
});

export const paymentAssets = sqliteTable('payment_assets', {
	id: text('id').primaryKey(),
	symbol: text('symbol').notNull(),
	name: text('name').notNull(),
	isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
});

export const paymentAssetDeployments = sqliteTable('payment_asset_deployments', {
	id: text('id').primaryKey(),
	assetId: text('asset_id').notNull().references(() => paymentAssets.id, { onDelete: 'cascade' }),
	chainId: integer('chain_id').notNull().references(() => paymentChains.chainId, { onDelete: 'cascade' }),
	contractAddress: text('contract_address').notNull(),
	decimals: integer('decimals').notNull(),
	recipientAddress: text('recipient_address').notNull(),
	isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
}, (table) => [
	uniqueIndex('payment_asset_deployments_chain_contract_idx').on(table.chainId, table.contractAddress),
	index('payment_asset_deployments_asset_id_idx').on(table.assetId),
]);

export const paymentAssetPlanPrices = sqliteTable('payment_asset_plan_prices', {
	id: text('id').primaryKey(),
	deploymentId: text('deployment_id').notNull().references(() => paymentAssetDeployments.id, { onDelete: 'cascade' }),
	planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
	amountBaseUnits: text('amount_base_units').notNull(),
	durationDays: integer('duration_days').notNull(),
	isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
}, (table) => [
	index('payment_asset_plan_prices_deployment_id_idx').on(table.deploymentId),
	index('payment_asset_plan_prices_plan_id_idx').on(table.planId),
]);

export const cryptoPaymentOrders = sqliteTable('crypto_payment_orders', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	payerWalletId: text('payer_wallet_id').references(() => userWallets.id, { onDelete: 'set null' }),
	payerAddress: text('payer_address').notNull(),
	priceId: text('price_id').references(() => paymentAssetPlanPrices.id, { onDelete: 'set null' }),
	deploymentId: text('deployment_id').references(() => paymentAssetDeployments.id, { onDelete: 'set null' }),
	planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
	assetId: text('asset_id').references(() => paymentAssets.id, { onDelete: 'set null' }),
	chainId: integer('chain_id').notNull(),
	chainName: text('chain_name').notNull(),
	assetSymbol: text('asset_symbol').notNull(),
	assetName: text('asset_name').notNull(),
	contractAddress: text('contract_address').notNull(),
	recipientAddress: text('recipient_address').notNull(),
	amountBaseUnits: text('amount_base_units').notNull(),
	decimals: integer('decimals').notNull(),
	durationDays: integer('duration_days').notNull(),
	status: text('status', { enum: ['pending', 'paid', 'expired', 'failed'] }).notNull().default('pending'),
	txHash: text('tx_hash'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	paidAt: integer('paid_at'),
}, (table) => [
	index('crypto_payment_orders_user_id_id_idx').on(table.userId, table.id),
	index('crypto_payment_orders_status_expires_at_idx').on(table.status, table.expiresAt),
	uniqueIndex('crypto_payment_orders_chain_tx_hash_idx').on(table.chainId, table.txHash),
]);
