<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import CryptoPaymentOffers from '@/components/CryptoPaymentOffers.vue';
import CryptoPaymentHistoryTable from '@/components/CryptoPaymentHistoryTable.vue';
import RefundRequests from '@/components/RefundRequests.vue';
import WalletRuntimeProvider from '@/components/WalletRuntimeProvider';
import WalletSettings from '@/components/WalletSettings.vue';

type Payment = ApiSuccess<'/api/billing/list-my-payments'>['data']['items'][number];
type ActiveTab = 'plans' | 'history' | 'wallets' | 'refunds';

const activeTab = ref<ActiveTab>('plans');
const payments = ref<Payment[]>([]);
const loadingPayments = ref(true);
const cancelingPaymentId = ref<string | null>(null);
const checkingPaymentId = ref<string | null>(null);
const loadingReceiptId = ref<string | null>(null);
const offersReloadKey = ref(0);
const error = ref('');

async function loadPayments(): Promise<void> {
	loadingPayments.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/billing/list-my-payments', { limit: 20, cursor: null });
		if (!result.ok) {
			error.value = result.data.message || '決済履歴の取得に失敗しました';
			return;
		}
		payments.value = result.data.items;
	} catch (e) {
		error.value = String(e);
	} finally {
		loadingPayments.value = false;
	}
}

function setTab(tab: ActiveTab): void {
	activeTab.value = tab;
	if (tab === 'plans') offersReloadKey.value += 1;
	if (tab === 'history') void loadPayments();
}

function walletChanged(): void {
	offersReloadKey.value += 1;
}

function paymentCompleted(): void {
	void loadPayments();
}

async function cancelPayment(payment: Payment): Promise<void> {
	cancelingPaymentId.value = payment.id;
	error.value = '';
	try {
		const result = await apiPost('/api/billing/cancel-crypto-order', { orderId: payment.id });
		if (!result.ok) {
			error.value = result.data.message || '支払いのキャンセルに失敗しました';
			return;
		}
		await loadPayments();
	} catch (e) {
		error.value = String(e);
	} finally {
		cancelingPaymentId.value = null;
	}
}

async function checkPayment(payment: Payment): Promise<void> {
	checkingPaymentId.value = payment.id;
	error.value = '';
	try {
		const result = await apiPost('/api/billing/check-crypto-order', { orderId: payment.id });
		if (!result.ok) {
			error.value = result.data.message || '支払いの再確認に失敗しました';
			return;
		}
		await loadPayments();
		if (result.data.status === 'paid') offersReloadKey.value += 1;
	} catch (e) {
		error.value = String(e);
	} finally {
		checkingPaymentId.value = null;
	}
}

async function openReceipt(payment: Payment): Promise<void> {
	loadingReceiptId.value = payment.id;
	error.value = '';
	try {
		const result = await apiPost('/api/billing/get-payment-receipt', { orderId: payment.id });
		if (!result.ok) {
			error.value = result.data.message || '領収書の取得に失敗しました';
			return;
		}
		const { downloadReceiptPdf } = await import('@/utils/receipt-pdf');
		await downloadReceiptPdf(result.data);
	} catch (e) {
		error.value = String(e);
	} finally {
		loadingReceiptId.value = null;
	}
}

onMounted(loadPayments);
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">支払い管理</h2>
    </div>

    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>
    <template v-else>
      <div class="tab-bar mb-4" role="tablist" aria-label="支払い管理">
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'plans' }" role="tab" :aria-selected="activeTab === 'plans'" @click="setTab('plans')">プラン購入</button>
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'history' }" role="tab" :aria-selected="activeTab === 'history'" @click="setTab('history')">決済履歴</button>
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'wallets' }" role="tab" :aria-selected="activeTab === 'wallets'" @click="setTab('wallets')">ウォレット</button>
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'refunds' }" role="tab" :aria-selected="activeTab === 'refunds'" @click="setTab('refunds')">返金申請</button>
      </div>

      <WalletRuntimeProvider v-if="activeTab !== 'history'">
        <section v-if="activeTab === 'plans'" role="tabpanel">
          <CryptoPaymentOffers :reload-key="offersReloadKey" @purchased="paymentCompleted" />
        </section>

        <section v-else-if="activeTab === 'wallets'" role="tabpanel">
          <WalletSettings @changed="walletChanged" />
        </section>
        <section v-else role="tabpanel"><RefundRequests /></section>
      </WalletRuntimeProvider>

      <section v-else role="tabpanel">
        <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
        <CryptoPaymentHistoryTable
          :payments="payments"
          :loading="loadingPayments"
          :canceling-payment-id="cancelingPaymentId"
          :checking-payment-id="checkingPaymentId"
          :loading-receipt-id="loadingReceiptId"
          show-cancel
          show-receipt
          @cancel="cancelPayment"
          @check="checkPayment"
          @receipt="openReceipt"
        />
      </section>
    </template>
  </div>
</template>
