<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { encodeFunctionData } from 'viem';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import EffectiveQuotaDetails from '@/components/EffectiveQuotaDetails.vue';

type EffectiveQuota = ApiSuccess<'/api/account/effective-quota'>['data'];
type Offer = ApiSuccess<'/api/billing/list-crypto-offers'>['data'][number];
type Payment = ApiSuccess<'/api/billing/list-my-payments'>['data']['items'][number];
type LinkedWallet = ApiSuccess<'/api/account/wallets/list'>['data'][number];

declare global {
	interface Window {
		ethereum?: {
			request(args: { method: string; params?: unknown[] }): Promise<unknown>;
		};
	}
}

const erc20Abi = [{
	type: 'function',
	name: 'transfer',
	stateMutability: 'nonpayable',
	inputs: [
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
	],
	outputs: [{ name: '', type: 'bool' }],
}] as const;
const RECEIPT_POLL_INTERVAL_MS = 3_000;
const RECEIPT_TIMEOUT_MS = 30 * 60 * 1000;

type TransactionReceipt = {
	blockNumber: string | null;
	status?: string;
	transactionHash?: string;
};

const quota = ref<EffectiveQuota | null>(null);
const offers = ref<Offer[]>([]);
const payments = ref<Payment[]>([]);
const wallets = ref<LinkedWallet[]>([]);
const loading = ref(true);
const buyingOfferId = ref<string | null>(null);
const walletAddress = ref<string | null>(null);
const error = ref('');
const success = ref('');

async function loadQuota(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const [quotaResult, offersResult, paymentsResult, walletsResult] = await Promise.all([
			apiPost('/api/account/effective-quota'),
			apiPost('/api/billing/list-crypto-offers'),
			apiPost('/api/billing/list-my-payments', { limit: 20, cursor: null }),
			apiPost('/api/account/wallets/list'),
		]);
		if (!quotaResult.ok) {
			error.value = quotaResult.data.message || 'クォータの取得に失敗しました';
			return;
		}
		if (!offersResult.ok) {
			error.value = offersResult.data.message || '購入プランの取得に失敗しました';
			return;
		}
		if (!paymentsResult.ok) {
			error.value = paymentsResult.data.message || '決済履歴の取得に失敗しました';
			return;
		}
		if (!walletsResult.ok) {
			error.value = walletsResult.data.message || 'ウォレット連携情報の取得に失敗しました';
			return;
		}
		quota.value = quotaResult.data;
		offers.value = offersResult.data;
		payments.value = paymentsResult.data.items;
		wallets.value = walletsResult.data;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function connectWallet(): Promise<string> {
	if (!window.ethereum) throw new Error('Ethereum wallet が見つかりません');
	const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
	const account = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
	if (!account) throw new Error('ウォレット接続に失敗しました');
	walletAddress.value = account;
	return account;
}

async function switchChain(chainId: number): Promise<void> {
	if (!window.ethereum) throw new Error('Ethereum wallet が見つかりません');
	await window.ethereum.request({
		method: 'wallet_switchEthereumChain',
		params: [{ chainId: `0x${chainId.toString(16)}` }],
	});
}

async function buyOffer(offer: Offer): Promise<void> {
	buyingOfferId.value = offer.id;
	error.value = '';
	success.value = '';
	try {
		const from = walletAddress.value ?? await connectWallet();
		await switchChain(offer.chainId);
		const wallet = wallets.value.find(item => item.chainId === offer.chainId && item.address.toLowerCase() === from.toLowerCase());
		if (!wallet) throw new Error('このチェーンの連携済みウォレットで接続してください');
		const orderResult = await apiPost('/api/billing/create-crypto-order', { priceId: offer.id, payerWalletId: wallet.id });
		if (!orderResult.ok) throw new Error(orderResult.data.message);
		const txHash = await sendTokenTransfer(from, orderResult.data.contractAddress, orderResult.data.recipientAddress, orderResult.data.amountBaseUnits);
		await waitForTransactionConfirmations(txHash, Math.max(1, offer.confirmationsRequired));
		const confirmResult = await apiPost('/api/billing/confirm-crypto-order', { orderId: orderResult.data.id, txHash });
		if (!confirmResult.ok) throw new Error(confirmResult.data.message);
		success.value = '決済を確認し、プランを反映しました';
		await loadQuota();
	} catch (e) {
		error.value = String(e);
	} finally {
		buyingOfferId.value = null;
	}
}

async function sendTokenTransfer(from: string, contractAddress: string, recipientAddress: string, amountBaseUnits: string): Promise<`0x${string}`> {
	if (!window.ethereum) throw new Error('Ethereum wallet が見つかりません');
	const data = encodeFunctionData({
		abi: erc20Abi,
		functionName: 'transfer',
		args: [recipientAddress as `0x${string}`, BigInt(amountBaseUnits)],
	});
	const txHash = await window.ethereum.request({
		method: 'eth_sendTransaction',
		params: [{
			from,
			to: contractAddress,
			data,
			value: '0x0',
		}],
	});
	if (typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('txHash の取得に失敗しました');
	return txHash as `0x${string}`;
}

async function waitForTransactionConfirmations(txHash: `0x${string}`, confirmationsRequired: number): Promise<void> {
	if (!window.ethereum) throw new Error('Ethereum wallet が見つかりません');
	const startedAt = Date.now();

	while (Date.now() - startedAt < RECEIPT_TIMEOUT_MS) {
		const receipt = await getTransactionReceipt(txHash);
		if (receipt?.blockNumber) {
			if (receipt.status === '0x0') throw new Error('送金トランザクションが失敗しました');
			const latestBlock = await getBlockNumber();
			const receiptBlock = parseHexQuantity(receipt.blockNumber);
			const confirmations = latestBlock >= receiptBlock ? latestBlock - receiptBlock + 1n : 0n;
			if (confirmations >= BigInt(confirmationsRequired)) return;
		}
		await sleep(RECEIPT_POLL_INTERVAL_MS);
	}

	throw new Error('送金トランザクションの確認がタイムアウトしました');
}

async function getTransactionReceipt(txHash: `0x${string}`): Promise<TransactionReceipt | null> {
	const receipt = await window.ethereum?.request({
		method: 'eth_getTransactionReceipt',
		params: [txHash],
	});
	if (receipt === null) return null;
	if (typeof receipt !== 'object') throw new Error('送金トランザクションの確認に失敗しました');
	return receipt as TransactionReceipt;
}

async function getBlockNumber(): Promise<bigint> {
	const blockNumber = await window.ethereum?.request({ method: 'eth_blockNumber' });
	if (typeof blockNumber !== 'string') throw new Error('ブロック番号の取得に失敗しました');
	return parseHexQuantity(blockNumber);
}

function parseHexQuantity(value: string): bigint {
	if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error('ブロック番号の形式が不正です');
	return BigInt(value);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function formatAmount(amountBaseUnits: string, decimals: number, symbol: string): string {
	const padded = amountBaseUnits.padStart(decimals + 1, '0');
	const integer = padded.slice(0, -decimals);
	const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
	return `${integer}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

function formatDate(value: number | null): string {
	return value == null ? '-' : new Date(value).toLocaleString();
}

onMounted(loadQuota);
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">マイクォータ</h2>
    </div>

    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>
    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>
      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <template v-else>
        <div :class="['card', $style.card]">
          <EffectiveQuotaDetails :quota="quota" />
        </div>

        <section :class="$style.section">
          <div class="section-header">
            <h3 :class="$style.sectionTitle">Crypto upgrade</h3>
            <button class="btn btn-secondary" type="button" @click="connectWallet">
              {{ walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : 'Wallet接続' }}
            </button>
          </div>
          <div v-if="offers.length === 0" class="text-muted">購入可能なプランはありません。</div>
          <div v-else :class="$style.offerGrid">
            <article v-for="offer in offers" :key="offer.id" class="card" :class="$style.offer">
              <div :class="$style.offerTitle">{{ offer.plan.name }}</div>
              <div :class="$style.offerMeta">{{ offer.assetSymbol }} / {{ offer.chainName }}</div>
              <div :class="$style.offerAmount">{{ formatAmount(offer.amountBaseUnits, offer.decimals, offer.assetSymbol) }}</div>
              <div :class="$style.offerMeta">{{ offer.durationDays }}日</div>
              <div :class="$style.offerMeta">
                RPC: {{ offer.isRpcConfigured ? '設定済み' : '未設定' }}
              </div>
              <button class="btn btn-primary" type="button" :disabled="buyingOfferId !== null || !offer.isRpcConfigured" @click="buyOffer(offer)">
                {{ buyingOfferId === offer.id ? '処理中...' : '購入' }}
              </button>
            </article>
          </div>
        </section>

        <section :class="$style.section">
          <h3 :class="$style.sectionTitle">決済履歴</h3>
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr><th>Asset</th><th>Chain</th><th>Status</th><th>tx</th><th>paidAt</th></tr>
              </thead>
              <tbody>
                <tr v-for="payment in payments" :key="payment.id">
                  <td>{{ payment.assetSymbol }}</td>
                  <td>{{ payment.chainName }}</td>
                  <td>{{ payment.status }}</td>
                  <td><code>{{ payment.txHash ?? '-' }}</code></td>
                  <td>{{ formatDate(payment.paidAt) }}</td>
                </tr>
                <tr v-if="payments.length === 0">
                  <td colspan="5" class="text-muted">決済履歴はありません。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style module lang="scss">
.card {
  max-width: 700px;
}

.section {
  margin-top: 24px;
}

.sectionTitle {
  margin: 0;
  font-size: 1rem;
}

.offerGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.offer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.offerTitle {
  font-weight: 600;
}

.offerMeta {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.offerAmount {
  font-size: 1.25rem;
  font-weight: 700;
}
</style>
