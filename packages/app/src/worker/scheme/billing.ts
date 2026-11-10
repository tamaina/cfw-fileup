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

// Payment assets are the pricing unit. For stablecoin payments this can be USD,
// while each token that can settle that price lives in paymentAssetDeployments.
export const paymentAssets = sqliteTable('payment_assets', {
	id: text('id').primaryKey(),
	symbol: text('symbol').notNull(),
	name: text('name').notNull(),
	currencyCode: text('currency_code').notNull().default('USD'),
	isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
});

// A deployment is a concrete ERC-20 token on a chain, such as USDC or USDT,
// that settles prices denominated by its parent payment asset.
export const paymentAssetDeployments = sqliteTable('payment_asset_deployments', {
	id: text('id').primaryKey(),
	assetId: text('asset_id').notNull().references(() => paymentAssets.id, { onDelete: 'cascade' }),
	chainId: integer('chain_id').notNull().references(() => paymentChains.chainId, { onDelete: 'cascade' }),
	tokenSymbol: text('token_symbol').notNull(),
	tokenName: text('token_name').notNull(),
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

// Plan prices are defined once per pricing asset and fan out to all enabled
// deployments for that asset when users choose a payment token.
export const paymentAssetPlanPrices = sqliteTable('payment_asset_plan_prices', {
	id: text('id').primaryKey(),
	assetId: text('asset_id').notNull().references(() => paymentAssets.id, { onDelete: 'cascade' }),
	planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
	amountBaseUnits: text('amount_base_units').notNull(),
	durationDays: integer('duration_days').notNull(),
	durationUnit: text('duration_unit', { enum: ['days', 'months', 'years'] }).notNull().default('days'),
	startsAt: integer('starts_at').notNull(),
	expiresAt: integer('expires_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
}, (table) => [
	index('payment_asset_plan_prices_plan_id_idx').on(table.planId),
	index('payment_asset_plan_prices_starts_at_idx').on(table.startsAt),
	index('payment_asset_plan_prices_expires_at_idx').on(table.expiresAt),
	index('payment_asset_plan_prices_asset_plan_period_idx').on(table.assetId, table.planId, table.durationDays, table.durationUnit, table.startsAt, table.expiresAt),
]);

export const billingResidencyStatements = sqliteTable('billing_residency_statements', {
	id: text('id').primaryKey(),
	country: text('country').notNull(),
	statement: text('statement').notNull(),
	isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	retiredAt: integer('retired_at'),
}, (table) => [
	index('billing_residency_statements_country_enabled_idx').on(table.country, table.isEnabled),
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
	tokenSymbol: text('token_symbol').notNull(),
	tokenName: text('token_name').notNull(),
	planName: text('plan_name').notNull(),
	contractAddress: text('contract_address').notNull(),
	recipientAddress: text('recipient_address').notNull(),
	amountBaseUnits: text('amount_base_units').notNull(),
	decimals: integer('decimals').notNull(),
	durationDays: integer('duration_days').notNull(),
	durationUnit: text('duration_unit', { enum: ['days', 'months', 'years'] }).notNull().default('days'),
	quoteCreatedAt: integer('quote_created_at').notNull(),
	quoteExpiresAt: integer('quote_expires_at').notNull(),
	quoteBaseAmountBaseUnits: text('quote_base_amount_base_units').notNull(),
	quoteDiscountBaseUnits: text('quote_discount_base_units').notNull(),
	quoteEffectiveStartsAt: integer('quote_effective_starts_at').notNull(),
	quoteEffectiveExpiresAt: integer('quote_effective_expires_at').notNull(),
	quoteCurrentPlanId: text('quote_current_plan_id'),
	quoteCurrentPlanName: text('quote_current_plan_name'),
	quoteCurrentPlanExpiresAt: integer('quote_current_plan_expires_at'),
	quoteCurrentPlanPriceAmountBaseUnits: text('quote_current_plan_price_amount_base_units'),
	quoteCurrentPlanPriceDurationDays: integer('quote_current_plan_price_duration_days'),
	quoteCurrentPlanPriceDurationUnit: text('quote_current_plan_price_duration_unit', { enum: ['days', 'months', 'years'] }),
	quoteDiscountAssignmentIds: text('quote_discount_assignment_ids').notNull().default('[]'),
	billingRevision: integer('billing_revision').notNull().default(0),
	status: text('status', { enum: ['pending', 'paid', 'expired', 'failed'] }).notNull().default('pending'),
	txHash: text('tx_hash'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	paidAt: integer('paid_at'),
	cfRegionSnapshot: text('cf_region_snapshot').notNull().default('{}'),
	taxName: text('tax_name').notNull().default('消費税'),
	taxRate: text('tax_rate').notNull().default('0.1'),
	taxCurrency: text('tax_currency').notNull().default('USD'),
	taxIncludedAmountBaseUnits: text('tax_included_amount_base_units').notNull().default('0'),
	taxExcludedAmountBaseUnits: text('tax_excluded_amount_base_units').notNull().default('0'),
	taxAmountBaseUnits: text('tax_amount_base_units').notNull().default('0'),
	taxStatementId: text('tax_statement_id').references(() => billingResidencyStatements.id, { onDelete: 'set null' }),
}, (table) => [
	index('crypto_payment_orders_user_id_id_idx').on(table.userId, table.id),
	index('crypto_payment_orders_status_expires_at_idx').on(table.status, table.expiresAt),
	uniqueIndex('crypto_payment_orders_chain_tx_hash_idx').on(table.chainId, table.txHash),
]);
