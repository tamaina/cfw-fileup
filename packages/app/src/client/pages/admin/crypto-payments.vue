<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import NirA from '@/components/NirA.vue';

type Chain = ApiSuccess<'/api/admin/list-payment-chains'>['data'][number];
type Asset = ApiSuccess<'/api/admin/list-payment-assets'>['data'][number];
type Deployment = ApiSuccess<'/api/admin/list-payment-asset-deployments'>['data'][number];
type Price = ApiSuccess<'/api/admin/list-payment-asset-plan-prices'>['data'][number];
type Plan = ApiSuccess<'/api/admin/list-plans'>['data'][number];
type Order = ApiSuccess<'/api/admin/list-crypto-payment-orders'>['data']['items'][number];

const chains = ref<Chain[]>([]);
const assets = ref<Asset[]>([]);
const deployments = ref<Deployment[]>([]);
const prices = ref<Price[]>([]);
const plans = ref<Plan[]>([]);
const orders = ref<Order[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const success = ref('');

const chainForm = ref({
	chainId: 8453,
	name: 'Base',
	nativeCurrencyName: 'Ether',
	nativeCurrencySymbol: 'ETH',
	nativeCurrencyDecimals: 18,
	blockExplorerUrl: 'https://basescan.org',
	confirmationsRequired: 1,
	isEnabled: true,
});
const assetForm = ref({ symbol: 'USDC', name: 'USD Coin', isEnabled: true });
const deploymentForm = ref({
	assetId: '',
	chainId: 8453,
	contractAddress: '',
	decimals: 6,
	recipientAddress: '',
	isEnabled: true,
});
const priceForm = ref({
	deploymentId: '',
	planId: '',
	amountBaseUnits: '',
	durationDays: 90,
	isEnabled: true,
});

const enabledDeployments = computed(() => deployments.value.filter(deployment => deployment.isEnabled));

onMounted(loadAll);

async function loadAll(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const [chainRes, assetRes, deploymentRes, priceRes, planRes, orderRes] = await Promise.all([
			apiPost('/api/admin/list-payment-chains'),
			apiPost('/api/admin/list-payment-assets'),
			apiPost('/api/admin/list-payment-asset-deployments'),
			apiPost('/api/admin/list-payment-asset-plan-prices'),
			apiPost('/api/admin/list-plans'),
			apiPost('/api/admin/list-crypto-payment-orders', { limit: 20, cursor: null }),
		]);
		if (!chainRes.ok) throw new Error(chainRes.data.message);
		if (!assetRes.ok) throw new Error(assetRes.data.message);
		if (!deploymentRes.ok) throw new Error(deploymentRes.data.message);
		if (!priceRes.ok) throw new Error(priceRes.data.message);
		if (!planRes.ok) throw new Error(planRes.data.message);
		if (!orderRes.ok) throw new Error(orderRes.data.message);
		chains.value = chainRes.data;
		assets.value = assetRes.data;
		deployments.value = deploymentRes.data;
		prices.value = priceRes.data;
		plans.value = planRes.data;
		orders.value = orderRes.data.items;
		if (!deploymentForm.value.assetId && assets.value[0]) deploymentForm.value.assetId = assets.value[0].id;
		if (!priceForm.value.deploymentId && deployments.value[0]) priceForm.value.deploymentId = deployments.value[0].id;
		if (!priceForm.value.planId && plans.value[0]) priceForm.value.planId = plans.value[0].id;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function saveChain(): Promise<void> {
	await save(async () => apiPost('/api/admin/create-payment-chain', { ...chainForm.value, blockExplorerUrl: chainForm.value.blockExplorerUrl || null }), 'チェーンを作成しました');
}

async function saveAsset(): Promise<void> {
	await save(async () => apiPost('/api/admin/create-payment-asset', assetForm.value), '通貨を作成しました');
}

async function saveDeployment(): Promise<void> {
	await save(async () => apiPost('/api/admin/create-payment-asset-deployment', deploymentForm.value), 'デプロイメントを作成しました');
}

async function savePrice(): Promise<void> {
	await save(async () => apiPost('/api/admin/create-payment-asset-plan-price', priceForm.value), '価格を作成しました');
}

async function save(action: () => Promise<{ ok: boolean; data: unknown }>, message: string): Promise<void> {
	saving.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await action();
		if (!result.ok) throw new Error('保存に失敗しました');
		success.value = message;
		await loadAll();
	} catch (e) {
		error.value = String(e);
	} finally {
		saving.value = false;
	}
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
</script>

<template>
  <div>
    <NirA to="/admin" class="back-link">← 管理パネルに戻る</NirA>

    <div class="section-header">
      <h2 class="section-title">Crypto payments</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">管理者権限が必要です。</div>

    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>
      <div v-if="loading" class="page-loading"><span class="spinner" />読み込み中...</div>

      <div v-else :class="$style.layout">
        <section :class="$style.section">
          <h3 :class="$style.panelTitle">チェーン</h3>
          <form :class="$style.formGrid" @submit.prevent="saveChain">
            <input v-model.number="chainForm.chainId" class="form-input" type="number" min="1" placeholder="Chain ID">
            <input v-model="chainForm.name" class="form-input" type="text" placeholder="Name">
            <input v-model="chainForm.nativeCurrencyName" class="form-input" type="text" placeholder="Native currency name">
            <input v-model="chainForm.nativeCurrencySymbol" class="form-input" type="text" placeholder="Symbol">
            <input v-model.number="chainForm.nativeCurrencyDecimals" class="form-input" type="number" min="0" max="255" placeholder="Decimals">
            <input v-model="chainForm.blockExplorerUrl" class="form-input" type="url" placeholder="Explorer URL">
            <input v-model.number="chainForm.confirmationsRequired" class="form-input" type="number" min="1" placeholder="Confirmations">
            <label :class="$style.checkbox"><input v-model="chainForm.isEnabled" type="checkbox">有効</label>
            <button class="btn btn-primary" type="submit" :disabled="saving">作成</button>
          </form>
          <table class="data-table">
            <thead><tr><th>Chain</th><th>RPC</th><th>Confirmations</th><th>状態</th></tr></thead>
            <tbody>
              <tr v-for="chain in chains" :key="chain.chainId">
                <td>{{ chain.name }} ({{ chain.chainId }})</td>
                <td><span :class="chain.isRpcConfigured ? 'badge badge-success' : 'badge badge-muted'">{{ chain.isRpcConfigured ? '設定済み' : '未設定' }}</span></td>
                <td>{{ chain.confirmationsRequired }}</td>
                <td>{{ chain.isEnabled ? '有効' : '無効' }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section :class="$style.section">
          <h3 :class="$style.panelTitle">通貨とデプロイメント</h3>
          <form :class="$style.formGrid" @submit.prevent="saveAsset">
            <input v-model="assetForm.symbol" class="form-input" type="text" placeholder="Symbol">
            <input v-model="assetForm.name" class="form-input" type="text" placeholder="Name">
            <label :class="$style.checkbox"><input v-model="assetForm.isEnabled" type="checkbox">有効</label>
            <button class="btn btn-primary" type="submit" :disabled="saving">通貨を作成</button>
          </form>
          <form :class="$style.formGrid" @submit.prevent="saveDeployment">
            <select v-model="deploymentForm.assetId" class="form-input">
              <option v-for="asset in assets" :key="asset.id" :value="asset.id">{{ asset.symbol }}</option>
            </select>
            <select v-model.number="deploymentForm.chainId" class="form-input">
              <option v-for="chain in chains" :key="chain.chainId" :value="chain.chainId">{{ chain.name }}</option>
            </select>
            <input v-model="deploymentForm.contractAddress" class="form-input" type="text" placeholder="Contract address">
            <input v-model.number="deploymentForm.decimals" class="form-input" type="number" min="0" max="255" placeholder="Decimals">
            <input v-model="deploymentForm.recipientAddress" class="form-input" type="text" placeholder="Recipient address">
            <label :class="$style.checkbox"><input v-model="deploymentForm.isEnabled" type="checkbox">有効</label>
            <button class="btn btn-primary" type="submit" :disabled="saving">デプロイメントを作成</button>
          </form>
          <table class="data-table">
            <thead><tr><th>Asset</th><th>Chain</th><th>Contract</th><th>Recipient</th><th>RPC</th></tr></thead>
            <tbody>
              <tr v-for="deployment in deployments" :key="deployment.id">
                <td>{{ deployment.assetSymbol }}</td>
                <td>{{ deployment.chainName }}</td>
                <td><code>{{ deployment.contractAddress }}</code></td>
                <td><code>{{ deployment.recipientAddress }}</code></td>
                <td>{{ deployment.isRpcConfigured ? '設定済み' : '未設定' }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section :class="$style.section">
          <h3 :class="$style.panelTitle">プラン価格</h3>
          <form :class="$style.formGrid" @submit.prevent="savePrice">
            <select v-model="priceForm.deploymentId" class="form-input">
              <option v-for="deployment in enabledDeployments" :key="deployment.id" :value="deployment.id">{{ deployment.assetSymbol }} / {{ deployment.chainName }}</option>
            </select>
            <select v-model="priceForm.planId" class="form-input">
              <option v-for="plan in plans" :key="plan.id" :value="plan.id">{{ plan.name }}</option>
            </select>
            <input v-model="priceForm.amountBaseUnits" class="form-input" type="text" placeholder="Amount base units">
            <input v-model.number="priceForm.durationDays" class="form-input" type="number" min="1" placeholder="Duration days">
            <label :class="$style.checkbox"><input v-model="priceForm.isEnabled" type="checkbox">有効</label>
            <button class="btn btn-primary" type="submit" :disabled="saving">価格を作成</button>
          </form>
          <table class="data-table">
            <thead><tr><th>Offer</th><th>価格</th><th>期間</th><th>状態</th></tr></thead>
            <tbody>
              <tr v-for="price in prices" :key="price.id">
                <td>{{ price.plan.name }} / {{ price.assetSymbol }} / {{ price.chainName }}</td>
                <td>{{ formatAmount(price.amountBaseUnits, price.decimals, price.assetSymbol) }}</td>
                <td>{{ price.durationDays }}日</td>
                <td>{{ price.isEnabled ? '有効' : '無効' }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section :class="$style.section">
          <h3 :class="$style.panelTitle">最近の注文</h3>
          <table class="data-table">
            <thead><tr><th>ID</th><th>Asset</th><th>Chain</th><th>Status</th><th>tx</th><th>paidAt</th></tr></thead>
            <tbody>
              <tr v-for="order in orders" :key="order.id">
                <td><code>{{ order.id }}</code></td>
                <td>{{ order.assetSymbol }}</td>
                <td>{{ order.chainName }}</td>
                <td>{{ order.status }}</td>
                <td><code>{{ order.txHash ?? '-' }}</code></td>
                <td>{{ formatDate(order.paidAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
.layout {
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panelTitle {
  margin: 0;
  font-size: 1rem;
}

.formGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  align-items: center;
}

.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
