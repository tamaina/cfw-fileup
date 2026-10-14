import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { billingTransactionClaims, cryptoPaymentOrders, planFundingLots, plans, userPlanAssignments, users } from '../scheme';
import { fundingIntervalAmount } from '../../shared/billing-funding';
import { genEaidx } from '../../shared/eaid-x';
import { getDb } from './db';
import { apiError } from './api-error';
import { commitBillingBatch, getBillingState, prepareBillingQuery } from './billing-state';

type Order = typeof cryptoPaymentOrders.$inferSelect;

/** Apply cash and inherited credit lineage with the entitlement in one transaction. */
export async function applyFundedPurchase(env: Env, order: Order, now: number): Promise<Order> {
	const db = getDb(env);
	const state = await getBillingState(env, order.userId);
	if (state.lockRequestId !== null || state.revision !== order.billingRevision) {
		const current = await db.select().from(cryptoPaymentOrders).where(eq(cryptoPaymentOrders.id, order.id)).get();
		if (current?.status === 'paid') return current;
		throw apiError(409, 'REFUND_CONFLICT', 'プラン変更または返金予約があります。送信済み購入の確認を管理者に依頼してください。');
	}
	if (!order.assetId) throw apiError(400, 'PAYMENT_ORDER_NOT_FOUND');
	const ids = JSON.parse(order.quoteDiscountAssignmentIds) as string[];
	const target = await db.select().from(plans).where(eq(plans.id, order.planId)).get();
	if (!target) throw apiError(400, 'PAYMENT_ORDER_NOT_FOUND');
	const previous = ids.length && BigInt(order.quoteDiscountBaseUnits) > 0n
		? await db.select({ assignment: userPlanAssignments }).from(userPlanAssignments)
			.innerJoin(plans, eq(plans.id, userPlanAssignments.planId))
			.where(and(eq(userPlanAssignments.userId, order.userId), inArray(userPlanAssignments.id, ids),
				lt(plans.sortOrder, target.sortOrder), lt(userPlanAssignments.startsAt, order.quoteEffectiveExpiresAt), gt(userPlanAssignments.expiresAt, order.quoteEffectiveStartsAt)))
		: [];
	const newId = genEaidx(now);
	const assignment = {
		id: newId, userId: order.userId, planId: order.planId,
		startsAt: order.quoteEffectiveStartsAt, expiresAt: order.quoteEffectiveExpiresAt,
		priceAssetId: order.assetId, priceAmountBaseUnits: order.quoteBaseAmountBaseUnits,
		priceDurationDays: order.durationDays, priceDurationUnit: order.durationUnit,
		createdAt: now, updatedAt: now, refundProvenanceComplete: previous.length === ids.length || ids.length === 0,
	};
	const transferred: typeof planFundingLots.$inferInsert[] = [];
	const statements: D1PreparedStatement[] = [];
	for (const { assignment: old } of previous) {
		const lots = await db.select().from(planFundingLots).where(eq(planFundingLots.assignmentId, old.id));
		if (!old.refundProvenanceComplete || lots.length === 0) assignment.refundProvenanceComplete = false;
		const overlapStart = Math.max(old.startsAt, order.quoteEffectiveStartsAt);
		const overlapEnd = Math.min(old.expiresAt, order.quoteEffectiveExpiresAt);
		const kept = [
			{ startsAt: old.startsAt, expiresAt: overlapStart },
			{ startsAt: overlapEnd, expiresAt: old.expiresAt },
		].filter(period => period.expiresAt > period.startsAt);
		// Delete old funding first; retained pieces preserve their immutable basis.
		statements.push(prepareBillingQuery(env, db.delete(userPlanAssignments).where(eq(userPlanAssignments.id, old.id))));
		for (const period of kept) {
			const retainedId = genEaidx(now);
			statements.push(prepareBillingQuery(env, db.insert(userPlanAssignments).values({ ...old, ...period, id: retainedId, updatedAt: now })));
			for (const lot of lots) {
				const start = Math.max(lot.startsAt, period.startsAt);
				const end = Math.min(lot.expiresAt, period.expiresAt);
				if (end > start) statements.push(prepareBillingQuery(env, db.insert(planFundingLots).values({ ...lot, id: genEaidx(now), assignmentId: retainedId, startsAt: start, expiresAt: end })));
			}
		}
		for (const lot of lots) {
			const amount = fundingIntervalAmount(lot, overlapStart, overlapEnd);
			if (amount > 0n) transferred.push({
				id: genEaidx(now), assignmentId: newId, sourceOrderId: lot.sourceOrderId,
				basisAmountBaseUnits: amount.toString(), basisStartsAt: assignment.startsAt, basisExpiresAt: assignment.expiresAt,
				startsAt: assignment.startsAt, expiresAt: assignment.expiresAt,
			});
		}
	}
	statements.push(prepareBillingQuery(env, db.insert(userPlanAssignments).values(assignment)));
	// Include a zero cash lot: zero payable upgrades still carry provenance.
	transferred.push({ id: genEaidx(now), assignmentId: newId, sourceOrderId: order.id,
																				basisAmountBaseUnits: order.amountBaseUnits, basisStartsAt: assignment.startsAt, basisExpiresAt: assignment.expiresAt,
																				startsAt: assignment.startsAt, expiresAt: assignment.expiresAt });
	for (let offset = 0; offset < transferred.length; offset += 10) {
		statements.push(prepareBillingQuery(env, db.insert(planFundingLots).values(transferred.slice(offset, offset + 10))));
	}
	if (order.txHash) statements.push(prepareBillingQuery(env, db.insert(billingTransactionClaims).values({ chainId: order.chainId, txHash: order.txHash, ownerId: order.id }).onConflictDoNothing()));
	statements.push(prepareBillingQuery(env, db.update(cryptoPaymentOrders).set({ ...order, status: 'paid', paidAt: now, updatedAt: now }).where(eq(cryptoPaymentOrders.id, order.id))));
	statements.push(env.DB.prepare('UPDATE billing_states SET revision = revision + 1 WHERE user_id = ?').bind(order.userId));
	statements.push(prepareBillingQuery(env, db.update(users).set({ effectiveQuotaUpdatedAt: null }).where(eq(users.id, order.userId))));
	try {
		await commitBillingBatch(env, { userId: order.userId, revision: state.revision, lockRequestId: null,
																																		condition: 'EXISTS (SELECT 1 FROM crypto_payment_orders WHERE id = ? AND status = \'pending\') AND NOT EXISTS (SELECT 1 FROM billing_transaction_claims WHERE chain_id = ? AND tx_hash = ? AND owner_id <> ?)', conditionParams: [order.id, order.chainId, order.txHash, order.id], statements });
	} catch (error) {
		const current = await db.select().from(cryptoPaymentOrders).where(eq(cryptoPaymentOrders.id, order.id)).get();
		if (current?.status === 'paid') return current;
		throw error;
	}
	return { ...order, status: 'paid', paidAt: now, updatedAt: now };
}
