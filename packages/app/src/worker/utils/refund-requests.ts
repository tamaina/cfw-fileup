import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { paymentChains, refundRequests, refundTransfers } from '../scheme';
import { genEaidx } from '../../shared/eaid-x';
import { refundAuditStatement } from './refund-audit';
import { getDb } from './db';
import { apiError } from './api-error';
import { calculateRefundQuote } from './refund-quote';
import { billingErrorContains, commitBillingBatch, getBillingState, prepareBillingQuery } from './billing-state';
import type { RefundView } from '../../shared/api/refunds';

export async function getRefundView(env: Env, requestId: string, ownerId?: string): Promise<RefundView> {
	const db = getDb(env);
	const request = await db.select().from(refundRequests).where(and(eq(refundRequests.id, requestId), ownerId ? eq(refundRequests.userId, ownerId) : undefined)).get();
	if (!request) throw apiError(404, 'REFUND_NOT_FOUND');
	const transfers = await db.select().from(refundTransfers).where(eq(refundTransfers.requestId, request.id));
	return { request, transfers };
}

export async function listRefundViews(env: Env, ownerId?: string, cursor?: string | null): Promise<RefundView[]> {
	const rows = await getDb(env).select({ id: refundRequests.id }).from(refundRequests)
		.where(and(ownerId ? eq(refundRequests.userId, ownerId) : undefined, cursor ? lt(refundRequests.id, cursor) : undefined)).orderBy(desc(refundRequests.id)).limit(100);
	return Promise.all(rows.map(row => getRefundView(env, row.id, ownerId)));
}

export async function createRefundRequest(env: Env, userId: string, key: string, cutoffAt: number | null): Promise<RefundView> {
	const db = getDb(env);
	const mode = cutoffAt === null ? 'immediate' : 'scheduled';
	const existing = await db.select().from(refundRequests).where(and(eq(refundRequests.userId, userId), eq(refundRequests.idempotencyKey, key))).get();
	if (existing) {
		if (existing.requestedMode !== mode || (cutoffAt !== null && existing.requestedCutoffAt !== cutoffAt)) throw apiError(409, 'REFUND_CONFLICT');
		return getRefundView(env, existing.id, userId);
	}
	const now = Date.now();
	if (cutoffAt !== null && cutoffAt < now) throw apiError(400, 'REFUND_INVALID', '終了希望日時は今以降を指定してください。');
	const id = genEaidx(now);
	try {
		await db.insert(refundRequests).values({ id, userId, idempotencyKey: key, requestedMode: mode, requestedCutoffAt: cutoffAt ?? now, createdAt: now, updatedAt: now });
	} catch (error) {
		if (!billingErrorContains(error, 'UNIQUE constraint failed')) throw error;
		const raced = await db.select().from(refundRequests).where(and(eq(refundRequests.userId, userId), eq(refundRequests.idempotencyKey, key))).get();
		if (raced?.requestedMode === mode && (cutoffAt === null || raced.requestedCutoffAt === cutoffAt)) return getRefundView(env, raced.id, userId);
		throw apiError(409, 'REFUND_CONFLICT', '未完了の返金申請があります。申請履歴を確認してください。');
	}
	return getRefundView(env, id, userId);
}

export async function prepareRefundRequest(env: Env, id: string, actorId: string, version: number, cutoffAt: number, reason: string, revision: number): Promise<RefundView> {
	const { request } = await getRefundView(env, id);
	if (request.status === 'prepared' && request.effectiveCutoffAt === cutoffAt && request.adjustmentReason === reason) return getRefundView(env, id);
	if (!['requested', 'review_required'].includes(request.status) || request.version !== version) throw apiError(409, 'REFUND_CONFLICT');
	if (cutoffAt !== request.requestedCutoffAt && reason.trim() === '') throw apiError(400, 'REFUND_INVALID', '終了日時の調整理由を入力してください。');
	// Admin discretion cannot backdate before the user's original request.
	if (cutoffAt < request.requestedCutoffAt) throw apiError(400, 'REFUND_INVALID', '希望日時より前には調整できません。');
	const quote = await calculateRefundQuote(env, request.userId, cutoffAt);
	if (quote.revision !== revision) throw apiError(409, 'REFUND_CONFLICT');
	const db = getDb(env);
	if (quote.reviewReasons.length > 0) {
		await db.update(refundRequests).set({ quote, status: 'review_required', version: version + 1, updatedAt: Date.now() })
			.where(and(eq(refundRequests.id, id), eq(refundRequests.version, version), inArray(refundRequests.status, ['requested', 'review_required'])));
		return getRefundView(env, id);
	}
	if (quote.assignments.length === 0) throw apiError(400, 'REFUND_INVALID', '対象となるプラン期間がありません。');
	const now = Date.now();
	const statements = [
		refundAuditStatement(env, actorId, request.userId, id, 'admin_refund_prepared'),
		prepareBillingQuery(env, db.update(refundRequests).set({ quote, status: 'prepared', actorUserId: actorId, effectiveCutoffAt: cutoffAt,
																																																											adjustmentReason: reason, version: version + 1, updatedAt: now }).where(eq(refundRequests.id, id))),
		env.DB.prepare('UPDATE billing_states SET lock_request_id = ? WHERE user_id = ?').bind(id, request.userId),
	];
	for (const group of quote.groups) {
		const chain = await db.select().from(paymentChains).where(eq(paymentChains.chainId, group.chainId)).get();
		if (!chain) throw apiError(400, 'PAYMENT_CHAIN_NOT_FOUND');
		statements.push(prepareBillingQuery(env, db.insert(refundTransfers).values({ id: group.id, requestId: id, chainId: group.chainId, confirmationsRequired: Math.max(1, chain.confirmationsRequired) })));
	}
	await commitBillingBatch(env, { userId: request.userId, revision, lockRequestId: null,
																																	condition: `EXISTS (SELECT 1 FROM refund_requests WHERE id = ? AND version = ? AND status IN ('requested', 'review_required'))
		AND NOT EXISTS (SELECT 1 FROM crypto_payment_orders WHERE user_id = ? AND status = 'pending' AND (expires_at > ? OR tx_hash IS NOT NULL))`,
																																	conditionParams: [id, version, request.userId, now], statements });
	return getRefundView(env, id);
}

export async function closeRefundRequest(env: Env, id: string, version: number, status: 'rejected' | 'cancelled', reason: string, ownerId?: string, actorId?: string): Promise<RefundView> {
	const { request } = await getRefundView(env, id, ownerId);
	if (request.status === status) return getRefundView(env, id, ownerId);
	if (!['requested', 'review_required', 'prepared'].includes(request.status) || request.version !== version) throw apiError(409, 'REFUND_CONFLICT');
	const state = await getBillingState(env, request.userId);
	const db = getDb(env);
	await commitBillingBatch(env, { userId: request.userId, revision: state.revision, lockRequestId: request.status === 'prepared' ? id : null,
																																	condition: `EXISTS (SELECT 1 FROM refund_requests WHERE id = ? AND version = ? AND status IN ('requested', 'review_required', 'prepared'))
		AND NOT EXISTS (SELECT 1 FROM refund_transfers WHERE request_id = ? AND status <> 'prepared')`, conditionParams: [id, version, id],
																																	statements: [
																																		refundAuditStatement(env, actorId ?? request.userId, request.userId, id, status === 'rejected' ? 'admin_refund_rejected' : 'user_refund_cancelled'),
																																		prepareBillingQuery(env, db.update(refundRequests).set({ status, decisionReason: reason, actorUserId: actorId ?? request.actorUserId, version: version + 1, updatedAt: Date.now() }).where(eq(refundRequests.id, id))),
																																		env.DB.prepare('UPDATE billing_states SET lock_request_id = NULL WHERE user_id = ?').bind(request.userId),
																																	] });
	return getRefundView(env, id, ownerId);
}
