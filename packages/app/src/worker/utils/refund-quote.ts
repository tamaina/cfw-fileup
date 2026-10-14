import { and, eq, gt } from 'drizzle-orm';
import { cryptoPaymentOrders, planFundingLots, refundSourceClaims, userPlanAssignments } from '../scheme';
import { groupBillingRefundLines, type BillingRefundLine } from '../../shared/billing-refund-groups';
import { fundingIntervalAmount } from '../../shared/billing-funding';
import { genEaidx } from '../../shared/eaid-x';
import { getDb } from './db';
import { getBillingState } from './billing-state';
import { apiError } from './api-error';
import type { RefundQuote } from '../../shared/api/refunds';

export async function calculateRefundQuote(env: Env, userId: string, cutoffAt: number): Promise<RefundQuote> {
	const db = getDb(env);
	const state = await getBillingState(env, userId);
	const assignments = await db.select().from(userPlanAssignments)
		.where(and(eq(userPlanAssignments.userId, userId), gt(userPlanAssignments.expiresAt, cutoffAt)));
	const reasons: string[] = [];
	const lines: BillingRefundLine[] = [];
	const orders = new Map<string, typeof cryptoPaymentOrders.$inferSelect>();
	for (const assignment of assignments) {
		const funding = await db.select({ lot: planFundingLots, order: cryptoPaymentOrders }).from(planFundingLots)
			.innerJoin(cryptoPaymentOrders, eq(planFundingLots.sourceOrderId, cryptoPaymentOrders.id))
			.where(eq(planFundingLots.assignmentId, assignment.id));
		if (!assignment.refundProvenanceComplete || funding.length === 0) {
			reasons.push(`割当 ${assignment.id}: 原購入・充当の由来が不明です。管理者の確認が必要です。`);
			continue;
		}
		for (const { lot, order } of funding) {
			if (order.status !== 'paid' || order.userId !== userId) throw apiError(409, 'REFUND_REVIEW_REQUIRED');
			orders.set(order.id, order);
			const amount = fundingIntervalAmount(lot, Math.max(cutoffAt, assignment.startsAt), assignment.expiresAt);
			lines.push({ id: lot.id, assignmentId: assignment.id, amountBaseUnits: amount.toString(),
																sourceOrder: { id: order.id, payerAddress: order.payerAddress, chainId: order.chainId, contractAddress: order.contractAddress, decimals: order.decimals } });
		}
	}
	const claimed = await db.select().from(refundSourceClaims)
		.innerJoin(cryptoPaymentOrders, eq(refundSourceClaims.sourceOrderId, cryptoPaymentOrders.id))
		.where(eq(cryptoPaymentOrders.userId, userId));
	for (const order of orders.values()) {
		const refunded = claimed.filter(row => row.refund_source_claims.sourceOrderId === order.id)
			.reduce((sum, row) => sum + BigInt(row.refund_source_claims.amountBaseUnits), 0n);
		const allocated = lines.filter(line => line.sourceOrder.id === order.id).reduce((sum, line) => sum + BigInt(line.amountBaseUnits), 0n);
		if (allocated + refunded > BigInt(order.amountBaseUnits)) reasons.push(`注文 ${order.id}: 原支払額を超える配賦があるため管理者確認が必要です。`);
	}
	const groups = groupBillingRefundLines(lines).filter(group => BigInt(group.amountBaseUnits) > 0n).map(group => {
		const reference = orders.get(group.lines[0].sourceOrder.id);
		if (!reference) throw apiError(409, 'REFUND_REVIEW_REQUIRED');
		return { ...group, id: genEaidx(Date.now()), tokenSymbol: reference.tokenSymbol, chainName: reference.chainName,
											lines: group.lines.map(line => {
												const order = orders.get(line.sourceOrder.id);
												if (!order) throw apiError(409, 'REFUND_REVIEW_REQUIRED');
												const gross = BigInt(line.amountBaseUnits);
												const cash = BigInt(order.amountBaseUnits);
												const tax = cash > 0n ? BigInt(order.taxAmountBaseUnits) * gross / cash : 0n;
												return { ...line, taxName: order.taxName, taxRate: order.taxRate, taxCurrency: order.taxCurrency,
																					taxAmountBaseUnits: tax.toString(), taxExcludedAmountBaseUnits: (gross - tax).toString() };
											}),
		};
	});
	const after = await getBillingState(env, userId);
	if (after.revision !== state.revision) throw apiError(409, 'REFUND_CONFLICT');
	return { revision: state.revision, effectiveCutoffAt: cutoffAt,
										assignments: assignments.map(({ id, startsAt, expiresAt }) => ({ id, startsAt, expiresAt })), groups, reviewReasons: reasons };
}
