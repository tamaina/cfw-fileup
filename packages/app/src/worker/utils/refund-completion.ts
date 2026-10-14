import { and, eq, gt, sql } from 'drizzle-orm';
import { planFundingLots, refundRequests, refundSourceClaims, refundTransfers, userPlanAssignments } from '../scheme';
import { genEaidx } from '../../shared/eaid-x';
import { refundAuditStatement } from './refund-audit';
import { getDb } from './db';
import { getRefundView } from './refund-requests';
import { verifyRefundTransfer, type RefundProof } from './refund-proof';
import { apiError } from './api-error';
import { commitBillingBatch, prepareBillingQuery } from './billing-state';
import { getBillingReceiptSeller } from './billing-tax';
import { refreshEffectiveQuotaForUser } from './rate-limit';

export async function checkRefundRequest(env: Env, id: string, actorId: string) {
	const view = await getRefundView(env, id);
	const { request } = view;
	if (request.status === 'completed') return view;
	if (!['prepared', 'processing'].includes(request.status) || !request.quote || request.effectiveCutoffAt === null) throw apiError(409, 'REFUND_CONFLICT');
	const db = getDb(env);
	const proofs = new Map<string, RefundProof>();
	for (const group of request.quote.groups) {
		const transfer = view.transfers.find(row => row.id === group.id);
		if (!transfer) throw apiError(409, 'REFUND_CONFLICT');
		const proof = await verifyRefundTransfer(env, group, transfer);
		if (proof) proofs.set(group.id, proof);
		// Chain status alone is informational; it never applies any entitlement.
		await db.update(refundTransfers).set({ status: proof ? 'verified' : transfer.txHash ? 'submitted' : transfer.status,
																																									blockHash: proof?.blockHash ?? null, blockNumber: proof?.blockNumber ?? null, logIndex: proof?.logIndex ?? null })
			.where(and(eq(refundTransfers.id, group.id), eq(refundTransfers.version, transfer.version), sql`EXISTS (SELECT 1 FROM refund_requests WHERE id = ${id} AND status IN ('prepared','processing'))`));
	}
	if (proofs.size !== request.quote.groups.length) return getRefundView(env, id);
	// A previously verified group may reorg while another group is pending.
	// Verify every receipt again at the final boundary, not just cached statuses.
	for (const group of request.quote.groups) {
		const transfer = view.transfers.find(row => row.id === group.id);
		if (!transfer) throw apiError(409, 'REFUND_CONFLICT');
		const fresh = await verifyRefundTransfer(env, group, transfer);
		if (!fresh || fresh.blockHash !== proofs.get(group.id)?.blockHash) {
			await db.update(refundTransfers).set({ status: 'submitted', blockHash: null, blockNumber: null, logIndex: null }).where(and(eq(refundTransfers.id, group.id), eq(refundTransfers.version, transfer.version), sql`EXISTS (SELECT 1 FROM refund_requests WHERE id = ${id} AND status IN ('prepared','processing'))`));
			return getRefundView(env, id);
		}
		proofs.set(group.id, fresh);
	}
	const seller = await getBillingReceiptSeller(env);
	const now = Date.now();
	const statements: D1PreparedStatement[] = [refundAuditStatement(env, actorId, request.userId, id, 'admin_refund_completed')];
	const conditions: Array<{ sql: string; params: unknown[] }> = [];
	for (const assignment of request.quote.assignments) {
		conditions.push({ sql: 'EXISTS (SELECT 1 FROM user_plan_assignments WHERE id = ? AND user_id = ? AND starts_at = ? AND expires_at = ?)', params: [assignment.id, request.userId, assignment.startsAt, assignment.expiresAt] });
		if (assignment.startsAt >= request.effectiveCutoffAt) {
			statements.push(prepareBillingQuery(env, db.delete(userPlanAssignments).where(eq(userPlanAssignments.id, assignment.id))));
		} else {
			statements.push(prepareBillingQuery(env, db.update(userPlanAssignments).set({ expiresAt: request.effectiveCutoffAt, updatedAt: now }).where(eq(userPlanAssignments.id, assignment.id))));
			statements.push(prepareBillingQuery(env, db.delete(planFundingLots).where(and(eq(planFundingLots.assignmentId, assignment.id), gt(planFundingLots.startsAt, request.effectiveCutoffAt - 1)))));
			statements.push(prepareBillingQuery(env, db.update(planFundingLots).set({ expiresAt: request.effectiveCutoffAt })
				.where(and(eq(planFundingLots.assignmentId, assignment.id), gt(planFundingLots.expiresAt, request.effectiveCutoffAt)))));
		}
	}
	for (const group of request.quote.groups) {
		const transfer = view.transfers.find(row => row.id === group.id);
		const proof = proofs.get(group.id);
		if (!transfer || !proof) throw apiError(409, 'REFUND_CONFLICT');
		conditions.push({ sql: 'EXISTS (SELECT 1 FROM refund_transfers WHERE id = ? AND request_id = ? AND version = ? AND tx_hash IS ? AND sender_address IS ?)', params: [group.id, id, transfer.version, transfer.txHash, transfer.senderAddress] });
		statements.push(prepareBillingQuery(env, db.update(refundTransfers).set({ ...proof, status: 'verified', version: transfer.version + 1 }).where(eq(refundTransfers.id, group.id))));
		for (const line of group.lines) statements.push(prepareBillingQuery(env, db.insert(refundSourceClaims).values({ id: genEaidx(now), requestId: id, sourceOrderId: line.sourceOrder.id, amountBaseUnits: line.amountBaseUnits })));
	}
	statements.push(prepareBillingQuery(env, db.update(refundRequests).set({ status: 'completed', completedAt: now, seller, version: request.version + 1, updatedAt: now }).where(eq(refundRequests.id, id))));
	statements.push(env.DB.prepare('UPDATE billing_states SET revision = revision + 1, lock_request_id = NULL WHERE user_id = ?').bind(request.userId));
	statements.push(env.DB.prepare('UPDATE users SET effective_quota_updated_at = NULL WHERE id = ?').bind(request.userId));
	try {
		await commitBillingBatch(env, { userId: request.userId, revision: request.quote.revision, lockRequestId: id,
																																		condition: 'EXISTS (SELECT 1 FROM refund_requests WHERE id = ? AND version = ? AND status IN (\'prepared\',\'processing\'))',
																																		conditionParams: [id, request.version], conditions, statements });
	} catch (error) {
		const latest = await getRefundView(env, id);
		if (latest.request.status === 'completed') return latest;
		throw error;
	}
	// Invalidated inside the commit; a failed refresh cannot retain the old quota.
	try { await refreshEffectiveQuotaForUser(env, request.userId, now); } catch (error) { console.warn('Refund quota refresh will retry on next access', String(error)); }
	return getRefundView(env, id);
}
