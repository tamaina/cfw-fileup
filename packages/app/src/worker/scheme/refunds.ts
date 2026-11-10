import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users';
import { userPlanAssignments } from './rate-limits';
import { cryptoPaymentOrders } from './billing';
import type { RefundQuote, RefundSeller } from '../../shared/api/refunds';

export const billingStates = sqliteTable('billing_states', {
	userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
	revision: integer('revision').notNull().default(0),
	lockRequestId: text('lock_request_id'),
});

// A failed CAS must abort the entire D1 batch, not merely update zero rows.
export const billingGuards = sqliteTable('billing_guards', {
	id: text('id').primaryKey(),
	valid: integer('valid').notNull(),
}, table => [check('billing_guard_valid', sql`${table.valid} = 1`)]);

export const billingTransactionClaims = sqliteTable('billing_transaction_claims', {
	chainId: integer('chain_id').notNull(),
	txHash: text('tx_hash').notNull(),
	ownerId: text('owner_id').notNull(),
}, table => [uniqueIndex('billing_transaction_proof_idx').on(table.chainId, table.txHash)]);

export const planFundingLots = sqliteTable('plan_funding_lots', {
	id: text('id').primaryKey(),
	assignmentId: text('assignment_id').notNull().references(() => userPlanAssignments.id, { onDelete: 'cascade' }),
	sourceOrderId: text('source_order_id').notNull().references(() => cryptoPaymentOrders.id, { onDelete: 'restrict' }),
	// Basis remains immutable after partial refunds; active bounds can shrink.
	basisAmountBaseUnits: text('basis_amount_base_units').notNull(),
	basisStartsAt: integer('basis_starts_at').notNull(),
	basisExpiresAt: integer('basis_expires_at').notNull(),
	startsAt: integer('starts_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
}, table => [index('plan_funding_assignment_idx').on(table.assignmentId)]);

export const refundRequests = sqliteTable('refund_requests', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
	idempotencyKey: text('idempotency_key').notNull(),
	requestedCutoffAt: integer('requested_cutoff_at').notNull(),
	requestedMode: text('requested_mode', { enum: ['immediate', 'scheduled'] }).notNull(),
	effectiveCutoffAt: integer('effective_cutoff_at'),
	adjustmentReason: text('adjustment_reason').notNull().default(''),
	decisionReason: text('decision_reason').notNull().default(''),
	actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
	status: text('status', { enum: ['requested', 'review_required', 'prepared', 'processing', 'completed', 'rejected', 'cancelled'] }).notNull().default('requested'),
	version: integer('version').notNull().default(0),
	quote: text('quote', { mode: 'json' }).$type<RefundQuote | null>(),
	seller: text('seller', { mode: 'json' }).$type<RefundSeller | null>(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	completedAt: integer('completed_at'),
}, table => [
	uniqueIndex('refund_request_idempotency_idx').on(table.userId, table.idempotencyKey),
	// Released when completed/rejected/cancelled; limits duplicate open requests.
	uniqueIndex('refund_request_open_user_idx').on(table.userId).where(sql`${table.status} IN ('requested', 'review_required', 'prepared', 'processing')`),
]);

export const refundTransfers = sqliteTable('refund_transfers', {
	id: text('id').primaryKey(),
	requestId: text('request_id').notNull().references(() => refundRequests.id, { onDelete: 'restrict' }),
	chainId: integer('chain_id').notNull(),
	confirmationsRequired: integer('confirmations_required').notNull().default(1),
	senderAddress: text('sender_address'),
	txHash: text('tx_hash'),
	status: text('status', { enum: ['prepared', 'broadcast_pending', 'submitted', 'verified'] }).notNull().default('prepared'),
	version: integer('version').notNull().default(0),
	startedAt: integer('started_at'),
	blockHash: text('block_hash'),
	blockNumber: text('block_number'),
	logIndex: integer('log_index'),
}, table => [
	index('refund_transfer_request_idx').on(table.requestId),
	uniqueIndex('refund_transfer_proof_idx').on(table.chainId, table.txHash),
]);

export const refundSourceClaims = sqliteTable('refund_source_claims', {
	id: text('id').primaryKey(),
	requestId: text('request_id').notNull().references(() => refundRequests.id, { onDelete: 'restrict' }),
	sourceOrderId: text('source_order_id').notNull().references(() => cryptoPaymentOrders.id, { onDelete: 'restrict' }),
	amountBaseUnits: text('amount_base_units').notNull(),
}, table => [index('refund_source_order_idx').on(table.sourceOrderId)]);
