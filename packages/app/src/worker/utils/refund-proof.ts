import { createPublicClient, decodeEventLog, http, parseAbiItem, TransactionReceiptNotFoundError } from 'viem';
import { getPaymentChainRpcUrl, normalizeEthAddress } from './payment-rpc';
import { normalizeTransactionHash } from './billing';
import { apiError, ApiError } from './api-error';
import type { RefundQuote, RefundView } from '../../shared/api/refunds';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export type RefundProof = { blockHash: string; blockNumber: string; logIndex: number };

export async function verifyRefundTransfer(env: Env, group: RefundQuote['groups'][number], transfer: RefundView['transfers'][number]): Promise<RefundProof | null> {
	if (!transfer.txHash || !transfer.senderAddress || transfer.startedAt === null) return null;
	const rpc = getPaymentChainRpcUrl(env, group.chainId);
	if (!rpc) throw apiError(400, 'PAYMENT_CHAIN_RPC_NOT_CONFIGURED');
	const client = createPublicClient({ transport: http(rpc) });
	try {
		if (await client.getChainId() !== group.chainId) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		const receipt = await client.getTransactionReceipt({ hash: normalizeTransactionHash(transfer.txHash) });
		if (receipt.status !== 'success') throw apiError(400, 'PAYMENT_TRANSACTION_INVALID', '返金トランザクションが失敗しています。再送せず管理者が確認してください。');
		const latest = await client.getBlockNumber();
		if (latest < receipt.blockNumber || latest - receipt.blockNumber + 1n < BigInt(Math.max(1, transfer.confirmationsRequired))) return null;
		const block = await client.getBlock({ blockNumber: receipt.blockNumber });
		if (block.hash !== receipt.blockHash) return null;
		const timestamp = Number(block.timestamp) * 1000;
		if (!Number.isSafeInteger(timestamp) || timestamp + 2000 < transfer.startedAt) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		const token = normalizeEthAddress(group.contractAddress);
		const sender = normalizeEthAddress(transfer.senderAddress);
		const recipient = normalizeEthAddress(group.payerAddress);
		for (const log of receipt.logs) {
			if (log.removed || log.address.toLowerCase() !== token) continue;
			try {
				const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
				if (String(decoded.args.from).toLowerCase() === sender && String(decoded.args.to).toLowerCase() === recipient && decoded.args.value === BigInt(group.amountBaseUnits)) {
					return { blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), logIndex: log.logIndex };
				}
			} catch { /* Other token events cannot satisfy this refund. */ }
		}
		throw apiError(400, 'PAYMENT_TRANSACTION_INVALID', '原購入者・送金元・トークン・返金額と一致するTransferがありません。');
	} catch (error) {
		if (error instanceof ApiError) throw error;
		if (!(error instanceof TransactionReceiptNotFoundError)) console.warn('Refund RPC verification pending', String(error));
		return null;
	}
}
