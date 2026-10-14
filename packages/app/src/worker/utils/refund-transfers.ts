import { eq } from 'drizzle-orm';
import { billingTransactionClaims, refundRequests, refundTransfers } from '../scheme';
import { refundAuditStatement } from './refund-audit';
import { getDb } from './db';
import { apiError } from './api-error';
import { normalizeEthAddress } from './payment-rpc';
import { normalizeTransactionHash } from './billing';
import { getRefundView } from './refund-requests';
import { commitBillingBatch, getBillingState, prepareBillingQuery } from './billing-state';

export async function startRefundTransfer(env: Env, id: string, transferId: string, version: number, senderAddress: string, actorId: string) {
	const view = await getRefundView(env, id);
	const transfer = view.transfers.find(row => row.id === transferId);
	if (!transfer || !view.request.quote) throw apiError(404, 'REFUND_NOT_FOUND');
	const sender = normalizeEthAddress(senderAddress);
	if (transfer.status !== 'prepared') throw apiError(409, 'REFUND_CONFLICT', '送信開始済みです。送信結果が不明な場合も再送せずTx Hashを確認してください。');
	if (!['prepared', 'processing'].includes(view.request.status) || view.request.version !== version) throw apiError(409, 'REFUND_CONFLICT');
	const state = await getBillingState(env, view.request.userId);
	const db = getDb(env);
	await commitBillingBatch(env, { userId: view.request.userId, revision: view.request.quote.revision, lockRequestId: id,
																																	condition: `EXISTS (SELECT 1 FROM refund_requests WHERE id = ? AND version = ? AND status IN ('prepared','processing'))
		AND EXISTS (SELECT 1 FROM refund_transfers WHERE id = ? AND request_id = ? AND status = 'prepared')`,
																																	conditionParams: [id, version, transferId, id], statements: [
																																		refundAuditStatement(env, actorId, view.request.userId, id, 'admin_refund_transfer_started'),
																																		prepareBillingQuery(env, db.update(refundTransfers).set({ status: 'broadcast_pending', senderAddress: sender, startedAt: Date.now(), version: transfer.version + 1 }).where(eq(refundTransfers.id, transferId))),
																																		prepareBillingQuery(env, db.update(refundRequests).set({ status: 'processing', version: version + 1, updatedAt: Date.now() }).where(eq(refundRequests.id, id))),
																																	] });
	if (state.lockRequestId !== id) throw apiError(409, 'REFUND_CONFLICT');
	return getRefundView(env, id);
}

export async function submitRefundTransfer(env: Env, id: string, transferId: string, txHash: string, actorId: string) {
	const view = await getRefundView(env, id);
	const transfer = view.transfers.find(row => row.id === transferId);
	if (!transfer || !view.request.quote) throw apiError(404, 'REFUND_NOT_FOUND');
	const hash = normalizeTransactionHash(txHash);
	if (transfer.txHash === hash) return view;
	if (transfer.txHash || transfer.status !== 'broadcast_pending' || view.request.status !== 'processing') throw apiError(409, 'REFUND_CONFLICT');
	const db = getDb(env);
	try {
		await commitBillingBatch(env, { userId: view.request.userId, revision: view.request.quote.revision, lockRequestId: id,
																																		condition: `EXISTS (SELECT 1 FROM refund_transfers WHERE id = ? AND request_id = ? AND status = 'broadcast_pending' AND tx_hash IS NULL)
		AND NOT EXISTS (SELECT 1 FROM crypto_payment_orders WHERE chain_id = ? AND tx_hash = ?)`,
																																		conditionParams: [transferId, id, transfer.chainId, hash], statements: [
																																			refundAuditStatement(env, actorId, view.request.userId, id, 'admin_refund_transfer_submitted'),
																																			prepareBillingQuery(env, db.insert(billingTransactionClaims).values({ chainId: transfer.chainId, txHash: hash, ownerId: transferId })),
																																			prepareBillingQuery(env, db.update(refundTransfers).set({ txHash: hash, status: 'submitted', version: transfer.version + 1 }).where(eq(refundTransfers.id, transferId))),
																																		] });
	} catch (error) {
		const latest = await getRefundView(env, id);
		if (latest.transfers.find(row => row.id === transferId)?.txHash === hash) return latest;
		throw error;
	}
	return getRefundView(env, id);
}
