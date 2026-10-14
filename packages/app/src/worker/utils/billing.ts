import { and, asc, desc, eq, gt, lt, ne, or } from 'drizzle-orm';
import { createPublicClient, decodeEventLog, http, isAddress, parseAbiItem, TransactionReceiptNotFoundError, type Hex, type TransactionReceipt } from 'viem';
import { addPaymentDuration } from '../../shared/billing-quote';
import { genEaidx } from '../../shared/eaid-x';
import { cryptoPaymentOrders, paymentChains, plans, userPlanAssignments } from '../scheme/index';
import { ApiError, apiError } from './api-error';
import { getDb } from './db';
import { getPaymentChainRpcUrl, normalizeEthAddress } from './payment-rpc';
import { refreshEffectiveQuotaForUser } from './rate-limit';
import { getPublicAppUrl, reserveEmailNotification, sendAccountEmailLines } from './email';
import { getAppName } from './app-name';
import { getBillingReceiptSeller } from './billing-tax';
import { runBackgroundTask, type WaitUntil } from './background-task';
import { applyFundedPurchase } from './billing-funding';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ORDER_TTL_MS = 30 * 60 * 1000;
const TX_TIMESTAMP_TOLERANCE_MS = 2_000;

type OrderForConfirmation = typeof cryptoPaymentOrders.$inferSelect;
type PaymentVerificationResult = 'confirmed' | 'pending';
type CryptoPaymentOrderStatus = OrderForConfirmation['status'];

export type CheckedCryptoPaymentOrder = {
	before: { userId: string; status: CryptoPaymentOrderStatus };
	order: OrderForConfirmation;
};

async function sendPurchaseReceiptNotification(env: Env, order: OrderForConfirmation, now = Date.now()): Promise<void> {
	if (!await reserveEmailNotification(env, order.userId, 'purchase_receipt', `purchase:${order.id}`, now)) return;
	const appName = await getAppName(env);
	const seller = await getBillingReceiptSeller(env);
	const amount = formatBaseUnits(order.amountBaseUnits, order.decimals);
	const taxIncluded = formatBaseUnits(order.taxIncludedAmountBaseUnits, order.decimals);
	const taxExcluded = formatBaseUnits(order.taxExcludedAmountBaseUnits, order.decimals);
	const taxAmount = formatBaseUnits(order.taxAmountBaseUnits, order.decimals);
	await sendAccountEmailLines(env, order.userId, `${appName} レシート`, [
		`${appName} のプラン購入が完了しました。`,
		'',
		'レシート',
		`購入日時: ${new Date(order.paidAt ?? now).toISOString()}`,
		`注文ID: ${order.id}`,
		`プラン: ${order.planName}`,
		`利用期間: ${new Date(order.quoteEffectiveStartsAt).toISOString()} - ${new Date(order.quoteEffectiveExpiresAt).toISOString()}`,
		`支払額: ${amount} ${order.tokenSymbol}`,
		`税: ${order.taxName} (${order.taxRate})`,
		`税込: ${taxIncluded} ${order.taxCurrency}`,
		`税抜: ${taxExcluded} ${order.taxCurrency}`,
		`税額: ${taxAmount} ${order.taxCurrency}`,
		`チェーン: ${order.chainName}`,
		`トークン: ${order.tokenName} (${order.tokenSymbol})`,
		`Tx Hash: ${order.txHash ?? '-'}`,
		'',
		'販売者情報',
		`名称: ${seller.name}`,
		`住所: ${seller.address || '-'}`,
		`登録番号: ${seller.invoiceRegistrationNumber || '-'}`,
		'',
		'支払い履歴から領収書を確認できます。',
		`${getPublicAppUrl(env)}/my/payments`,
	]);
}

export function getCryptoPaymentOrderExpiresAt(now = Date.now()): number {
	return now + ORDER_TTL_MS;
}

export async function confirmCryptoPaymentOrder(env: Env, userId: string, orderId: string, txHash: string, waitUntil?: WaitUntil): Promise<typeof cryptoPaymentOrders.$inferSelect> {
	const db = getDb(env);
	const now = Date.now();
	const order = await db
		.select()
		.from(cryptoPaymentOrders)
		.where(and(eq(cryptoPaymentOrders.id, orderId), eq(cryptoPaymentOrders.userId, userId)))
		.get();

	if (!order) throw apiError(404, 'PAYMENT_ORDER_NOT_FOUND');
	if (order.status === 'paid') return order;
	if (order.status !== 'pending') {
		throw apiError(400, 'PAYMENT_ORDER_EXPIRED');
	}
	if (order.expiresAt <= now) {
		await db
			.update(cryptoPaymentOrders)
			.set({ status: 'expired', updatedAt: now })
			.where(and(eq(cryptoPaymentOrders.id, order.id), eq(cryptoPaymentOrders.status, 'pending')));
		throw apiError(400, 'PAYMENT_ORDER_EXPIRED');
	}
	assertValidBigIntString(order.amountBaseUnits);

	const normalizedTxHash = normalizeTransactionHash(txHash);
	if (order.txHash !== null && order.txHash !== normalizedTxHash) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
	const usedOrder = await db
		.select({ id: cryptoPaymentOrders.id })
		.from(cryptoPaymentOrders)
		.where(and(
			eq(cryptoPaymentOrders.chainId, order.chainId),
			eq(cryptoPaymentOrders.txHash, normalizedTxHash),
			ne(cryptoPaymentOrders.id, order.id),
		))
		.get();
	if (usedOrder) throw apiError(400, 'PAYMENT_TRANSACTION_ALREADY_USED');

	let submittedOrder: OrderForConfirmation;
	if (order.txHash === normalizedTxHash) {
		submittedOrder = order;
	} else {
		const submittedOrders = await db
			.update(cryptoPaymentOrders)
			.set({ txHash: normalizedTxHash, updatedAt: now })
			.where(and(eq(cryptoPaymentOrders.id, order.id), eq(cryptoPaymentOrders.status, 'pending')))
			.returning();
		if (submittedOrders.length === 0) throw apiError(400, 'PAYMENT_TRANSACTION_ALREADY_USED');
		submittedOrder = submittedOrders[0] as OrderForConfirmation;
	}

	let verificationResult: PaymentVerificationResult;
	try {
		verificationResult = await verifyCryptoPaymentTransaction(env, submittedOrder, normalizedTxHash);
	} catch (e) {
		if (e instanceof ApiError && e.code === 'PAYMENT_TRANSACTION_INVALID') {
			await markCryptoPaymentOrderFailed(db, order.id, now);
		}
		throw e;
	}
	if (verificationResult === 'pending') return submittedOrder;

	return await markCryptoPaymentOrderPaid(env, submittedOrder, normalizedTxHash, now, waitUntil);
}

export async function checkCryptoPaymentOrder(env: Env, userId: string, orderId: string, waitUntil?: WaitUntil): Promise<typeof cryptoPaymentOrders.$inferSelect> {
	const db = getDb(env);
	const now = Date.now();
	const order = await db
		.select()
		.from(cryptoPaymentOrders)
		.where(and(eq(cryptoPaymentOrders.id, orderId), eq(cryptoPaymentOrders.userId, userId)))
		.get();

	if (!order) throw apiError(404, 'PAYMENT_ORDER_NOT_FOUND');
	if (order.status === 'paid') return order;
	if (order.status !== 'pending') return order;
	if (order.txHash === null) {
		if (order.expiresAt <= now) {
			const expiredOrders = await db
				.update(cryptoPaymentOrders)
				.set({ status: 'expired', updatedAt: now })
				.where(and(eq(cryptoPaymentOrders.id, order.id), eq(cryptoPaymentOrders.status, 'pending')))
				.returning();
			return (expiredOrders[0] ?? order) as OrderForConfirmation;
		}
		return order;
	}

	const normalizedTxHash = normalizeTransactionHash(order.txHash);
	let verificationResult: PaymentVerificationResult;
	try {
		verificationResult = await verifyCryptoPaymentTransaction(env, order, normalizedTxHash);
	} catch (e) {
		if (e instanceof ApiError && e.code === 'PAYMENT_TRANSACTION_INVALID') {
			await markCryptoPaymentOrderFailed(db, order.id, now);
		}
		throw e;
	}
	if (verificationResult === 'pending') return order;

	return await markCryptoPaymentOrderPaid(env, order, normalizedTxHash, now, waitUntil);
}

export async function listCryptoPaymentOrders(env: Env, params: { userId?: string; cursor?: string | null; limit: number }): Promise<OrderForConfirmation[]> {
	const db = getDb(env);
	const where = params.userId && params.cursor
		? and(eq(cryptoPaymentOrders.userId, params.userId), lt(cryptoPaymentOrders.id, params.cursor))
		: params.userId
			? eq(cryptoPaymentOrders.userId, params.userId)
			: params.cursor
				? lt(cryptoPaymentOrders.id, params.cursor)
				: undefined;
	return await db
		.select()
		.from(cryptoPaymentOrders)
		.where(where)
		.orderBy(desc(cryptoPaymentOrders.id))
		.limit(params.limit);
}

export async function checkCryptoPaymentOrderWithPreviousStatus(env: Env, userId: string, orderId: string, waitUntil?: WaitUntil): Promise<CheckedCryptoPaymentOrder> {
	const db = getDb(env);
	const before = await db
		.select({ userId: cryptoPaymentOrders.userId, status: cryptoPaymentOrders.status })
		.from(cryptoPaymentOrders)
		.where(and(eq(cryptoPaymentOrders.id, orderId), eq(cryptoPaymentOrders.userId, userId)))
		.get();
	if (!before) throw apiError(404, 'PAYMENT_ORDER_NOT_FOUND');
	const order = await checkCryptoPaymentOrder(env, userId, orderId, waitUntil);
	return { before, order };
}

export async function checkAnyCryptoPaymentOrderWithPreviousStatus(env: Env, orderId: string, waitUntil?: WaitUntil): Promise<CheckedCryptoPaymentOrder> {
	const db = getDb(env);
	const before = await db
		.select({ userId: cryptoPaymentOrders.userId, status: cryptoPaymentOrders.status })
		.from(cryptoPaymentOrders)
		.where(eq(cryptoPaymentOrders.id, orderId))
		.get();
	if (!before) throw apiError(404, 'PAYMENT_ORDER_NOT_FOUND');
	const order = await checkCryptoPaymentOrder(env, before.userId, orderId, waitUntil);
	return { before, order };
}

export async function markZeroAmountCryptoPaymentOrderPaid(env: Env, userId: string, orderId: string, now = Date.now(), waitUntil?: WaitUntil): Promise<OrderForConfirmation> {
	const db = getDb(env);
	const order = await db.select().from(cryptoPaymentOrders).where(and(eq(cryptoPaymentOrders.id, orderId), eq(cryptoPaymentOrders.userId, userId))).get();
	if (!order) throw apiError(404, 'PAYMENT_ORDER_NOT_FOUND');
	if (order.status === 'paid') return order;
	if (order.status !== 'pending') throw apiError(400, 'PAYMENT_ORDER_EXPIRED');
	if (BigInt(order.amountBaseUnits) !== 0n) throw apiError(400, 'PAYMENT_QUOTE_INVALID');
	return finishFundedPurchase(env, order, now, waitUntil);
}

async function markCryptoPaymentOrderFailed(db: ReturnType<typeof getDb>, orderId: string, now: number): Promise<void> {
	await db.update(cryptoPaymentOrders).set({ status: 'failed', updatedAt: now }).where(and(eq(cryptoPaymentOrders.id, orderId), eq(cryptoPaymentOrders.status, 'pending')));
}

async function markCryptoPaymentOrderPaid(env: Env, order: OrderForConfirmation, normalizedTxHash: Hex, now: number, waitUntil?: WaitUntil): Promise<OrderForConfirmation> {
	return finishFundedPurchase(env, { ...order, txHash: normalizedTxHash }, now, waitUntil);
}

async function finishFundedPurchase(env: Env, order: OrderForConfirmation, now: number, waitUntil?: WaitUntil): Promise<OrderForConfirmation> {
	const period = getPaidOrderEffectivePeriod(order, now);
	const paid = await applyFundedPurchase(env, { ...order, quoteEffectiveStartsAt: period.startsAt, quoteEffectiveExpiresAt: period.expiresAt }, now);
	await refreshEffectiveQuotaForUser(env, order.userId, now, waitUntil);
	runBackgroundTask(waitUntil, sendPurchaseReceiptNotification(env, paid, now), 'Failed to send purchase receipt notification:');
	return paid;
}

function getPaidOrderEffectivePeriod(order: OrderForConfirmation, paidAt: number): { startsAt: number; expiresAt: number } {
	if (order.quoteCurrentPlanId !== null || order.quoteEffectiveStartsAt > order.quoteCreatedAt) {
		return {
			startsAt: order.quoteEffectiveStartsAt,
			expiresAt: order.quoteEffectiveExpiresAt,
		};
	}
	return {
		startsAt: paidAt,
		expiresAt: addPaymentDuration(paidAt, order.durationDays, order.durationUnit),
	};
}

async function verifyCryptoPaymentTransaction(env: Env, order: OrderForConfirmation, txHash: Hex): Promise<PaymentVerificationResult> {
	const rpcUrl = getPaymentChainRpcUrl(env, order.chainId);
	if (!rpcUrl) throw apiError(400, 'PAYMENT_CHAIN_RPC_NOT_CONFIGURED');

	const client = createPublicClient({ transport: http(rpcUrl) });
	try {
		const chainId = await client.getChainId();
		if (chainId !== order.chainId) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');

		let receipt: TransactionReceipt;
		try {
			receipt = await client.getTransactionReceipt({ hash: txHash });
		} catch (e) {
			if (e instanceof TransactionReceiptNotFoundError) return 'pending';
			throw e;
		}
		if (receipt.status !== 'success') throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');

		const confirmationsRequired = Math.max(1, await getConfirmationsRequired(env, order.chainId));
		if (confirmationsRequired > 1) {
			const blockNumber = await client.getBlockNumber();
			const confirmations = blockNumber >= receipt.blockNumber ? blockNumber - receipt.blockNumber + 1n : 0n;
			if (confirmations < BigInt(confirmationsRequired)) return 'pending';
		}

		const block = await client.getBlock({ blockNumber: receipt.blockNumber });
		const txTimestampMs = Number(block.timestamp) * 1000;
		if (!Number.isSafeInteger(txTimestampMs)) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		if (
			txTimestampMs + TX_TIMESTAMP_TOLERANCE_MS < order.createdAt
		) {
			throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		}
		if (txTimestampMs - TX_TIMESTAMP_TOLERANCE_MS > order.expiresAt) throw apiError(400, 'PAYMENT_ORDER_EXPIRED');

		const expectedContract = normalizeEthAddress(order.contractAddress);
		const expectedPayer = normalizeEthAddress(order.payerAddress);
		const expectedRecipient = normalizeEthAddress(order.recipientAddress);
		const expectedAmount = BigInt(order.amountBaseUnits);
		const hasExpectedTransfer = receipt.logs.some((log) => {
			if (log.address.toLowerCase() !== expectedContract) return false;
			try {
				const decoded = decodeEventLog({
					abi: [TRANSFER_EVENT],
					data: log.data,
					topics: log.topics,
				});
				const from = String(decoded.args.from).toLowerCase();
				const to = String(decoded.args.to).toLowerCase();
				const value = decoded.args.value;
				return from === expectedPayer && to === expectedRecipient && value >= expectedAmount;
			} catch {
				return false;
			}
		});

		if (!hasExpectedTransfer) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		return 'confirmed';
	} catch (e) {
		if (e instanceof ApiError) throw e;
		console.warn('Failed to verify crypto payment transaction:', e);
		return 'pending';
	}
}

async function getConfirmationsRequired(env: Env, chainId: number): Promise<number> {
	const db = getDb(env);
	const row = await db.select({ confirmationsRequired: paymentChains.confirmationsRequired }).from(paymentChains).where(eq(paymentChains.chainId, chainId)).get();
	return row?.confirmationsRequired ?? 1;
}

export async function expireDiscountedFuturePlanAssignment(env: Env, order: {
	userId: string;
	targetPlanId: string;
	quoteCurrentPlanId: string | null;
	quoteCurrentPlanExpiresAt: number | null;
	quoteCreatedAt: number;
	quoteDiscountBaseUnits: string;
	quoteDiscountAssignmentIds?: string[];
	quoteEffectiveStartsAt: number;
	quoteEffectiveExpiresAt: number;
	now: number;
}): Promise<void> {
	const quoteDiscountAssignmentIds = order.quoteDiscountAssignmentIds ?? [];
	if (
		order.quoteCurrentPlanId === null
		|| order.quoteCurrentPlanExpiresAt === null
		|| BigInt(order.quoteDiscountBaseUnits) <= 0n
		|| quoteDiscountAssignmentIds.length === 0
	) return;

	const db = getDb(env);
	const targetPlan = await db
		.select({ sortOrder: plans.sortOrder })
		.from(plans)
		.where(eq(plans.id, order.targetPlanId))
		.get();
	if (!targetPlan) return;

	const discountedAssignments = await db
		.select({
			id: userPlanAssignments.id,
			userId: userPlanAssignments.userId,
			planId: userPlanAssignments.planId,
			startsAt: userPlanAssignments.startsAt,
			expiresAt: userPlanAssignments.expiresAt,
			priceAssetId: userPlanAssignments.priceAssetId,
			priceAmountBaseUnits: userPlanAssignments.priceAmountBaseUnits,
			priceDurationDays: userPlanAssignments.priceDurationDays,
			priceDurationUnit: userPlanAssignments.priceDurationUnit,
			createdAt: userPlanAssignments.createdAt,
		})
		.from(userPlanAssignments)
		.innerJoin(plans, eq(userPlanAssignments.planId, plans.id))
		.where(and(
			eq(userPlanAssignments.userId, order.userId),
			or(...quoteDiscountAssignmentIds.map(id => eq(userPlanAssignments.id, id))),
			lt(plans.sortOrder, targetPlan.sortOrder),
			lt(userPlanAssignments.startsAt, order.quoteEffectiveExpiresAt),
			gt(userPlanAssignments.expiresAt, order.quoteEffectiveStartsAt),
		))
		.orderBy(asc(userPlanAssignments.startsAt), asc(userPlanAssignments.expiresAt));

	for (const assignment of discountedAssignments) {
		const overlapsStart = assignment.startsAt < order.quoteEffectiveStartsAt;
		const overlapsEnd = assignment.expiresAt > order.quoteEffectiveExpiresAt;
		if (!overlapsStart && !overlapsEnd) {
			await db.delete(userPlanAssignments).where(eq(userPlanAssignments.id, assignment.id));
		} else if (overlapsStart && overlapsEnd) {
			await db
				.update(userPlanAssignments)
				.set({ expiresAt: order.quoteEffectiveStartsAt, updatedAt: order.now })
				.where(eq(userPlanAssignments.id, assignment.id));
			await db.insert(userPlanAssignments).values({
				id: genEaidx(order.now),
				userId: assignment.userId,
				planId: assignment.planId,
				startsAt: order.quoteEffectiveExpiresAt,
				expiresAt: assignment.expiresAt,
				priceAssetId: assignment.priceAssetId,
				priceAmountBaseUnits: assignment.priceAmountBaseUnits,
				priceDurationDays: assignment.priceDurationDays,
				priceDurationUnit: assignment.priceDurationUnit,
				createdAt: order.now,
				updatedAt: order.now,
			});
		} else if (overlapsStart) {
			await db
				.update(userPlanAssignments)
				.set({ expiresAt: order.quoteEffectiveStartsAt, updatedAt: order.now })
				.where(eq(userPlanAssignments.id, assignment.id));
		} else {
			await db
				.update(userPlanAssignments)
				.set({ startsAt: order.quoteEffectiveExpiresAt, updatedAt: order.now })
				.where(eq(userPlanAssignments.id, assignment.id));
		}
	}
}

export function normalizeTransactionHash(txHash: string): Hex {
	if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
	return txHash.toLowerCase() as Hex;
}

export function assertValidBigIntString(value: string): void {
	try {
		if (BigInt(value) <= 0n) throw new Error('non-positive');
	} catch {
		throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
	}
}

export function assertValidPaymentAddress(address: string): void {
	if (!isAddress(address)) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
}

function formatBaseUnits(value: string, decimals: number): string {
	const amount = BigInt(value);
	const scale = 10n ** BigInt(decimals);
	const whole = amount / scale;
	const fraction = amount % scale;
	if (fraction === 0n) return whole.toString();
	return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function parseDiscountAssignmentIds(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
	} catch {
		return [];
	}
}

export function newPaymentId(now = Date.now()): string {
	return genEaidx(now);
}

export function cryptoPaymentOrderByNewest() {
	return desc(cryptoPaymentOrders.id);
}
