<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import CryptoPaymentOffers from '@/components/CryptoPaymentOffers.vue';
import WalletSettings from '@/components/WalletSettings.vue';

type Payment = ApiSuccess<'/api/billing/list-my-payments'>['data']['items'][number];
type ActiveTab = 'plans' | 'history' | 'wallets';

const activeTab = ref<ActiveTab>('plans');
const payments = ref<Payment[]>([]);
const loadingPayments = ref(true);
const cancelingPaymentId = ref<string | null>(null);
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

function formatDate(value: number | null): string {
	return value == null ? '-' : new Date(value).toLocaleString();
}

function formatAmount(amountBaseUnits: string | null, decimals: number, symbol: string): string {
	if (amountBaseUnits == null) return '-';
	const padded = amountBaseUnits.padStart(decimals + 1, '0');
	const integer = padded.slice(0, -decimals);
	const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
	return `${integer}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

function formatDuration(value: number, unit: 'days' | 'months' | 'years'): string {
	const label = unit === 'days' ? '日' : unit === 'months' ? 'ヶ月' : '年';
	return `${value}${label}`;
}

function canCancelPayment(payment: Payment): boolean {
	return payment.status === 'pending' && payment.txHash == null;
}

function paymentPlanName(payment: Payment): string {
	return payment.planName ?? 'プラン';
}

function paymentEffectiveExpiresAt(payment: Payment): number | null {
	return payment.quoteEffectiveExpiresAt ?? null;
}

function paymentDiscountBaseUnits(payment: Payment): string {
	return payment.quoteDiscountBaseUnits ?? '0';
}

function paymentStatusLabel(status: Payment['status']): string {
	switch (status) {
		case 'pending': return '保留中';
		case 'paid': return '支払い済み';
		case 'expired': return '期限切れ';
		case 'failed': return '失敗';
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
      </div>

      <section v-if="activeTab === 'plans'" role="tabpanel">
        <CryptoPaymentOffers :reload-key="offersReloadKey" @purchased="paymentCompleted" />
      </section>

      <section v-else-if="activeTab === 'history'" role="tabpanel">
        <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
        <div v-if="loadingPayments" class="page-loading">
          <span class="spinner" />読み込み中...
        </div>
        <div v-else :class="['card', $style.tableCard]">
          <div class="table-responsive">
            <table :class="['data-table', $style.historyTable]">
              <colgroup>
                <col :class="$style.colPlan">
                <col :class="$style.colAmount">
                <col :class="$style.colExpiry">
                <col :class="$style.colQuote">
                <col :class="$style.colStatus">
                <col :class="$style.colTx">
                <col :class="$style.colPaidAt">
                <col :class="$style.colActions">
	              </colgroup>
	              <thead>
	                <tr><th>プラン</th><th>支払額</th><th>購入後期限</th><th>計算内容</th><th>Status</th><th>tx</th><th>paidAt</th><th :class="['col-actions', $style.actionsCell]">操作</th></tr>
	              </thead>
              <tbody>
                <tr v-for="payment in payments" :key="payment.id">
                  <td>
                    <div :class="$style.cellPrimary">{{ paymentPlanName(payment) }}</div>
                    <div :class="['text-muted', $style.cellSecondary]">{{ payment.assetSymbol }} / {{ payment.chainName }}</div>
                  </td>
                  <td>
                    <div :class="$style.cellPrimary">{{ formatAmount(payment.amountBaseUnits, payment.decimals, payment.assetSymbol) }}</div>
                    <div v-if="paymentDiscountBaseUnits(payment) !== '0'" :class="['text-muted', $style.cellSecondary]">
                      通常 {{ formatAmount(payment.quoteBaseAmountBaseUnits, payment.decimals, payment.assetSymbol) }}
                    </div>
                  </td>
                  <td>{{ formatDate(paymentEffectiveExpiresAt(payment)) }}</td>
                  <td>
                    <div>{{ formatDuration(payment.durationDays, payment.durationUnit) }}</div>
                    <div v-if="paymentDiscountBaseUnits(payment) !== '0'" :class="['text-muted', $style.cellSecondary]">
                      割引 {{ formatAmount(paymentDiscountBaseUnits(payment), payment.decimals, payment.assetSymbol) }}
                    </div>
                    <div v-if="payment.quoteCurrentPlanName" :class="['text-muted', $style.cellSecondary]">
                      {{ payment.quoteCurrentPlanName }} の残り期間を {{ formatAmount(payment.quoteCurrentPlanPriceAmountBaseUnits ?? '0', payment.decimals, payment.assetSymbol) }} / {{ formatDuration(payment.quoteCurrentPlanPriceDurationDays ?? 1, payment.quoteCurrentPlanPriceDurationUnit ?? 'days') }} で按分
                    </div>
                  </td>
                  <td><span class="badge badge-info">{{ paymentStatusLabel(payment.status) }}</span></td>
                  <td>
                    <code :class="$style.hashText" :title="payment.txHash ?? undefined">{{ payment.txHash ?? '-' }}</code>
                  </td>
                  <td>{{ formatDate(payment.paidAt) }}</td>
	                  <td :class="['col-actions', $style.actionsCell]">
	                    <button v-show="canCancelPayment(payment)" class="btn btn-secondary btn-sm" :class="$style.actionButton" type="button" :disabled="cancelingPaymentId !== null" @click="cancelPayment(payment)">
                      {{ cancelingPaymentId === payment.id ? 'キャンセル中...' : 'キャンセル' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="payments.length === 0">
                  <td colspan="8" class="text-muted">決済履歴はありません。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-else role="tabpanel">
        <WalletSettings @changed="walletChanged" />
      </section>
    </template>
  </div>
</template>

<style module lang="scss">
.tableCard {
  max-width: none;
  padding: 0;
  overflow: hidden;
}

.historyTable {
  min-width: 1240px;
  table-layout: fixed;
}

.colPlan { width: 15%; }
.colAmount { width: 12%; }
.colExpiry { width: 14%; }
.colQuote { width: 22%; }
.colStatus { width: 8%; }
.colTx { width: 10%; }
.colPaidAt { width: 12%; }
.colActions { width: 120px; }

.actionsCell {
  min-width: 120px;
  text-align: right;
}

.actionButton {
  width: 100%;
}

.historyTable td {
  min-width: 0;
  overflow: hidden;
}

.cellPrimary,
.cellSecondary,
.hashText {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hashText {
  max-width: 100%;
}

@media (max-width: 900px) {
  .historyTable {
    min-width: 1240px;
  }

  .hashText {
    max-width: 7rem;
  }
}
</style>
