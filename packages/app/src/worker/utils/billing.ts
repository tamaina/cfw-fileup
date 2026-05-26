import { and, desc, eq, ne } from 'drizzle-orm';
import { createPublicClient, decodeEventLog, http, isAddress, parseAbiItem, type Hex } from 'viem';
import { genEaidx } from '../../shared/eaid-x';
import { cryptoPaymentOrders, paymentChains, userPlanAssignments } from '../scheme/index';
import { ApiError, apiError } from './api-error';
import { getDb } from './db';
import { getPaymentChainRpcUrl, normalizeEthAddress } from './payment-rpc';
import { refreshEffectiveQuotaForUser } from './rate-limit';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ORDER_TTL_MS = 30 * 60 * 1000;
const TX_TIMESTAMP_TOLERANCE_MS = 2_000;

type OrderForConfirmation = typeof cryptoPaymentOrders.$inferSelect;

export function getCryptoPaymentOrderExpiresAt(now = Date.now()): number {
	return now + ORDER_TTL_MS;
}

export async function confirmCryptoPaymentOrder(env: Env, userId: string, orderId: string, txHash: string): Promise<typeof cryptoPaymentOrders.$inferSelect> {
	const db = getDb(env);
	const now = Date.now();
	const order = await db
		.select()
		.from(cryptoPaymentOrders)
		.where(and(eq(cryptoPaymentOrders.id, orderId), eq(cryptoPaymentOrders.userId, userId)))
		.get();

	if (!order) throw apiError(404, 'PAYMENT_ORDER_NOT_FOUND');
	if (order.status === 'paid') return order;
	if (order.status !== 'pending' || order.expiresAt <= now) {
		await db.update(cryptoPaymentOrders).set({ status: 'expired', updatedAt: now }).where(eq(cryptoPaymentOrders.id, order.id));
		throw apiError(400, 'PAYMENT_ORDER_EXPIRED');
	}
	assertValidBigIntString(order.amountBaseUnits);

	const normalizedTxHash = normalizeTransactionHash(txHash);
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

	await verifyCryptoPaymentTransaction(env, order, normalizedTxHash);
	let claimedOrders: OrderForConfirmation[];
	try {
		claimedOrders = await db
			.update(cryptoPaymentOrders)
			.set({
				status: 'paid',
				txHash: normalizedTxHash,
				paidAt: now,
				updatedAt: now,
			})
			.where(and(eq(cryptoPaymentOrders.id, order.id), eq(cryptoPaymentOrders.status, 'pending')))
			.returning();
	} catch {
		throw apiError(400, 'PAYMENT_TRANSACTION_ALREADY_USED');
	}
	if (claimedOrders.length === 0) throw apiError(400, 'PAYMENT_TRANSACTION_ALREADY_USED');
	const claimedOrder = claimedOrders[0] as OrderForConfirmation;

	await applyPaidOrderPlan(env, claimedOrder, now);
	await refreshEffectiveQuotaForUser(env, userId, now);

	return claimedOrder;
}

async function verifyCryptoPaymentTransaction(env: Env, order: OrderForConfirmation, txHash: Hex): Promise<void> {
	const rpcUrl = getPaymentChainRpcUrl(env, order.chainId);
	if (!rpcUrl) throw apiError(400, 'PAYMENT_CHAIN_RPC_NOT_CONFIGURED');

	const client = createPublicClient({ transport: http(rpcUrl) });
	try {
		const chainId = await client.getChainId();
		if (chainId !== order.chainId) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');

		const receipt = await client.getTransactionReceipt({ hash: txHash });
		if (receipt.status !== 'success') throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');

		const confirmationsRequired = Math.max(1, await getConfirmationsRequired(env, order.chainId));
		if (confirmationsRequired > 1) {
			const blockNumber = await client.getBlockNumber();
			const confirmations = blockNumber >= receipt.blockNumber ? blockNumber - receipt.blockNumber + 1n : 0n;
			if (confirmations < BigInt(confirmationsRequired)) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		}

		const block = await client.getBlock({ blockNumber: receipt.blockNumber });
		const txTimestampMs = Number(block.timestamp) * 1000;
		if (!Number.isSafeInteger(txTimestampMs)) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		if (
			txTimestampMs + TX_TIMESTAMP_TOLERANCE_MS < order.createdAt
			|| txTimestampMs - TX_TIMESTAMP_TOLERANCE_MS > order.expiresAt
		) {
			throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		}

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
	} catch (e) {
		if (e instanceof ApiError) throw e;
		throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
	}
}

async function getConfirmationsRequired(env: Env, chainId: number): Promise<number> {
	const db = getDb(env);
	const row = await db.select({ confirmationsRequired: paymentChains.confirmationsRequired }).from(paymentChains).where(eq(paymentChains.chainId, chainId)).get();
	return row?.confirmationsRequired ?? 1;
}

async function applyPaidOrderPlan(env: Env, order: OrderForConfirmation, now: number): Promise<void> {
	const db = getDb(env);

	await db
		.insert(userPlanAssignments)
		.values({
			userId: order.userId,
			planId: order.planId,
			expiresAt: order.quoteEffectiveExpiresAt,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: userPlanAssignments.userId,
			set: {
				planId: order.planId,
				expiresAt: order.quoteEffectiveExpiresAt,
				updatedAt: now,
			},
	});
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

export function newPaymentId(now = Date.now()): string {
	return genEaidx(now);
}

export function cryptoPaymentOrderByNewest() {
	return desc(cryptoPaymentOrders.id);
}
