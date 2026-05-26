<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Dialog } from '@vuetify/v0';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import NirA from '@/components/NirA.vue';
import SettingItem from '@/components/SettingItem.vue';
import { KNOWN_SETTINGS } from '../../../shared/app-settings';

type Chain = ApiSuccess<'/api/admin/list-payment-chains'>['data'][number];
type Asset = ApiSuccess<'/api/admin/list-payment-assets'>['data'][number];
type Deployment = ApiSuccess<'/api/admin/list-payment-asset-deployments'>['data'][number];
type Price = ApiSuccess<'/api/admin/list-payment-asset-plan-prices'>['data'][number];
type Plan = ApiSuccess<'/api/admin/list-plans'>['data'][number];
type Order = ApiSuccess<'/api/admin/list-crypto-payment-orders'>['data']['items'][number];
type ActiveTab = 'chains' | 'assets' | 'deployments' | 'prices' | 'orders';
type SaveResult = { ok: true; data: unknown } | { ok: false; data: { error?: string; message?: string } };
type ChainCatalogEntry = {
	id: number;
	name: string;
	nativeCurrency: {
		name: string;
		symbol: string;
		decimals: number;
	};
	blockExplorers?: {
		default: {
			url: string;
		};
	};
};

const chains = ref<Chain[]>([]);
const assets = ref<Asset[]>([]);
const deployments = ref<Deployment[]>([]);
const prices = ref<Price[]>([]);
const plans = ref<Plan[]>([]);
const orders = ref<Order[]>([]);
const loading = ref(true);
const saving = ref(false);
const savingSetting = ref(false);
const chainAutofillLoading = ref(false);
const deploymentAutofillLoading = ref(false);
const error = ref('');
const success = ref('');
const chainAutofillMessage = ref('');
const deploymentAutofillMessage = ref('');
const activeTab = ref<ActiveTab>('chains');
const cryptoPaymentsEnabled = ref<'true' | 'false'>('false');
const editingChainId = ref<number | null>(null);
const editingDeploymentId = ref<string | null>(null);
const editingPrice = ref<Price | null>(null);
const priceExpiresAtDraft = ref('');
const rpcTestingChainId = ref<number | null>(null);
const rpcTestResults = ref<Record<number, { ok: boolean; message: string }>>({});

const defaultChainForm = {
	chainId: 8453,
	name: 'Base',
	nativeCurrencyName: 'Ether',
	nativeCurrencySymbol: 'ETH',
	nativeCurrencyDecimals: 18,
	blockExplorerUrl: 'https://basescan.org',
	confirmationsRequired: 1,
	isEnabled: true,
};
const chainForm = ref({ ...defaultChainForm });
const assetForm = ref({ symbol: 'USD', name: 'US Dollar', isEnabled: true });
const defaultDeploymentForm = {
	assetId: '',
	chainId: 8453,
	tokenSymbol: 'USDC',
	tokenName: 'USD Coin',
	contractAddress: '',
	decimals: 6,
	recipientAddress: '',
	isEnabled: true,
};
const deploymentForm = ref({ ...defaultDeploymentForm });
const DEFAULT_PRICE_DECIMALS = 6;
const priceForm = ref({
	assetId: '',
	planId: '',
	amount: '',
	durationDays: 90,
	durationUnit: 'days' as 'days' | 'months' | 'years',
	isEnabled: true,
	expiresAt: '',
});

const enabledDeployments = computed(() => deployments.value.filter(deployment => deployment.isEnabled));
const isEditingChain = computed(() => editingChainId.value != null);
const isEditingDeployment = computed(() => editingDeploymentId.value != null);
const selectedPriceAssetDecimals = computed(() => deployments.value.find(deployment => deployment.assetId === priceForm.value.assetId)?.decimals ?? DEFAULT_PRICE_DECIMALS);
const ethereumAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const decimalAmountPattern = /^(0|[1-9]\d*)(\.\d+)?$/;
const optionalHttpUrlPattern = /^https?:\/\//;
const canSaveChain = computed(() => (
	Number.isInteger(chainForm.value.chainId)
	&& chainForm.value.chainId >= 1
	&& chainForm.value.name.trim() !== ''
	&& chainForm.value.nativeCurrencyName.trim() !== ''
	&& chainForm.value.nativeCurrencySymbol.trim() !== ''
	&& Number.isInteger(chainForm.value.nativeCurrencyDecimals)
	&& chainForm.value.nativeCurrencyDecimals >= 0
	&& chainForm.value.nativeCurrencyDecimals <= 255
	&& Number.isInteger(chainForm.value.confirmationsRequired)
	&& chainForm.value.confirmationsRequired >= 1
	&& (
		chainForm.value.blockExplorerUrl.trim() === ''
		|| optionalHttpUrlPattern.test(chainForm.value.blockExplorerUrl.trim())
	)
));
const canSaveAsset = computed(() => assetForm.value.symbol.trim() !== '' && assetForm.value.name.trim() !== '');
const canSaveDeployment = computed(() => (
	deploymentForm.value.assetId !== ''
	&& Number.isInteger(deploymentForm.value.chainId)
	&& deploymentForm.value.chainId >= 1
	&& deploymentForm.value.tokenSymbol.trim() !== ''
	&& deploymentForm.value.tokenName.trim() !== ''
	&& ethereumAddressPattern.test(deploymentForm.value.contractAddress)
	&& Number.isInteger(deploymentForm.value.decimals)
	&& deploymentForm.value.decimals >= 0
	&& deploymentForm.value.decimals <= 255
	&& ethereumAddressPattern.test(deploymentForm.value.recipientAddress)
));
const canSavePrice = computed(() => (
	priceForm.value.assetId !== ''
	&& priceForm.value.planId !== ''
	&& parseDecimalAmount(priceForm.value.amount, selectedPriceAssetDecimals.value) !== null
	&& Number.isInteger(priceForm.value.durationDays)
	&& priceForm.value.durationDays >= 1
	&& ['days', 'months', 'years'].includes(priceForm.value.durationUnit)
	&& parseDateTimeLocal(priceForm.value.expiresAt) !== undefined
));

onMounted(loadAll);

async function loadAll(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const [chainRes, assetRes, deploymentRes, priceRes, planRes, orderRes, settingRes] = await Promise.all([
			apiPost('/api/admin/list-payment-chains'),
			apiPost('/api/admin/list-payment-assets'),
			apiPost('/api/admin/list-payment-asset-deployments'),
			apiPost('/api/admin/list-payment-asset-plan-prices'),
			apiPost('/api/admin/list-plans'),
			apiPost('/api/admin/list-crypto-payment-orders', { limit: 20, cursor: null }),
			apiPost('/api/admin/get-settings'),
		]);
		if (!chainRes.ok) throw new Error(chainRes.data.message);
		if (!assetRes.ok) throw new Error(assetRes.data.message);
		if (!deploymentRes.ok) throw new Error(deploymentRes.data.message);
		if (!priceRes.ok) throw new Error(priceRes.data.message);
		if (!planRes.ok) throw new Error(planRes.data.message);
		if (!orderRes.ok) throw new Error(orderRes.data.message);
		if (!settingRes.ok) throw new Error(settingRes.data.message);
		chains.value = chainRes.data;
		assets.value = assetRes.data;
		deployments.value = deploymentRes.data;
		prices.value = priceRes.data;
		plans.value = planRes.data;
		orders.value = orderRes.data.items;
		cryptoPaymentsEnabled.value = settingRes.data.find(setting => setting.key === 'crypto_payments_enabled')?.value ?? 'false';
		if (!deploymentForm.value.assetId && assets.value[0]) deploymentForm.value.assetId = assets.value[0].id;
		if (!priceForm.value.assetId && assets.value[0]) priceForm.value.assetId = assets.value[0].id;
		if (!priceForm.value.planId && plans.value[0]) priceForm.value.planId = plans.value[0].id;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function saveChain(): Promise<void> {
	const body = { ...chainForm.value, blockExplorerUrl: chainForm.value.blockExplorerUrl || null };
	await save(
		async () => isEditingChain.value
			? apiPost('/api/admin/update-payment-chain', body)
			: apiPost('/api/admin/create-payment-chain', body),
		isEditingChain.value ? 'チェーンを更新しました' : 'チェーンを作成しました',
	);
	if (isEditingChain.value) resetChainForm();
}

function startEditChain(chain: Chain): void {
	editingChainId.value = chain.chainId;
	chainForm.value = {
		chainId: chain.chainId,
		name: chain.name,
		nativeCurrencyName: chain.nativeCurrencyName,
		nativeCurrencySymbol: chain.nativeCurrencySymbol,
		nativeCurrencyDecimals: chain.nativeCurrencyDecimals,
		blockExplorerUrl: chain.blockExplorerUrl ?? '',
		confirmationsRequired: chain.confirmationsRequired,
		isEnabled: chain.isEnabled,
	};
	chainAutofillMessage.value = '';
}

function resetChainForm(): void {
	editingChainId.value = null;
	chainForm.value = { ...defaultChainForm };
	chainAutofillMessage.value = '';
}

async function testChainRpc(chain: Chain): Promise<void> {
	rpcTestingChainId.value = chain.chainId;
	rpcTestResults.value = {
		...rpcTestResults.value,
		[chain.chainId]: { ok: false, message: '確認中...' },
	};
	try {
		const result = await apiPost('/api/admin/test-payment-chain-rpc', { chainId: chain.chainId });
		if (!result.ok) throw new Error(result.data.message);
		rpcTestResults.value = {
			...rpcTestResults.value,
			[chain.chainId]: { ok: true, message: `OK (${result.data.chainId})` },
		};
	} catch (e) {
		rpcTestResults.value = {
			...rpcTestResults.value,
			[chain.chainId]: { ok: false, message: String(e) },
		};
	} finally {
		rpcTestingChainId.value = null;
	}
}

function isChainCatalogEntry(value: unknown): value is ChainCatalogEntry {
	if (typeof value !== 'object' || value === null) return false;
	const maybeChain = value as {
		id?: unknown;
		name?: unknown;
		nativeCurrency?: {
			name?: unknown;
			symbol?: unknown;
			decimals?: unknown;
		};
	};
	return typeof maybeChain.id === 'number'
		&& typeof maybeChain.name === 'string'
		&& typeof maybeChain.nativeCurrency === 'object'
		&& maybeChain.nativeCurrency !== null
		&& typeof maybeChain.nativeCurrency.name === 'string'
		&& typeof maybeChain.nativeCurrency.symbol === 'string'
		&& typeof maybeChain.nativeCurrency.decimals === 'number';
}

async function autofillChainFromCatalog(): Promise<void> {
	chainAutofillLoading.value = true;
	chainAutofillMessage.value = '';
	try {
		const chainCatalog = await import('viem/chains') as Record<string, unknown>;
		const chain = Object.values(chainCatalog)
			.find((value): value is ChainCatalogEntry => isChainCatalogEntry(value) && value.id === chainForm.value.chainId);
		if (!chain) {
			chainAutofillMessage.value = 'このChain IDはviem/chainsに見つかりませんでした。';
			return;
		}

		chainForm.value.name = chain.name;
		chainForm.value.nativeCurrencyName = chain.nativeCurrency.name;
		chainForm.value.nativeCurrencySymbol = chain.nativeCurrency.symbol;
		chainForm.value.nativeCurrencyDecimals = chain.nativeCurrency.decimals;
		chainForm.value.blockExplorerUrl = chain.blockExplorers?.default.url ?? '';
		chainAutofillMessage.value = `${chain.name} の情報を入力しました。`;
	} catch (e) {
		chainAutofillMessage.value = String(e);
	} finally {
		chainAutofillLoading.value = false;
	}
}

async function saveAsset(): Promise<void> {
	await save(async () => apiPost('/api/admin/create-payment-asset', assetForm.value), '通貨を作成しました');
}

async function toggleAssetEnabled(asset: Asset): Promise<void> {
	await save(async () => apiPost('/api/admin/update-payment-asset', {
		assetId: asset.id,
		symbol: asset.symbol,
		name: asset.name,
		isEnabled: !asset.isEnabled,
	}), asset.isEnabled ? '通貨を無効化しました' : '通貨を有効化しました');
}

async function saveDeployment(): Promise<void> {
	await save(
		async () => isEditingDeployment.value
			? apiPost('/api/admin/update-payment-asset-deployment', { deploymentId: editingDeploymentId.value!, ...deploymentForm.value })
			: apiPost('/api/admin/create-payment-asset-deployment', deploymentForm.value),
		isEditingDeployment.value ? 'デプロイメントを更新しました' : 'デプロイメントを作成しました',
	);
	if (isEditingDeployment.value) resetDeploymentForm();
}

function startEditDeployment(deployment: Deployment): void {
	editingDeploymentId.value = deployment.id;
	deploymentForm.value = {
		assetId: deployment.assetId,
		chainId: deployment.chainId,
		tokenSymbol: deployment.tokenSymbol,
		tokenName: deployment.tokenName,
		contractAddress: deployment.contractAddress,
		decimals: deployment.decimals,
		recipientAddress: deployment.recipientAddress,
		isEnabled: deployment.isEnabled,
	};
	deploymentAutofillMessage.value = '';
}

function resetDeploymentForm(): void {
	editingDeploymentId.value = null;
	deploymentForm.value = {
		...defaultDeploymentForm,
		assetId: assets.value[0]?.id ?? '',
	};
	deploymentAutofillMessage.value = '';
}

async function toggleDeploymentEnabled(deployment: Deployment): Promise<void> {
	await save(async () => apiPost('/api/admin/update-payment-asset-deployment', {
		deploymentId: deployment.id,
		assetId: deployment.assetId,
		chainId: deployment.chainId,
		tokenSymbol: deployment.tokenSymbol,
		tokenName: deployment.tokenName,
		contractAddress: deployment.contractAddress,
		decimals: deployment.decimals,
		recipientAddress: deployment.recipientAddress,
		isEnabled: !deployment.isEnabled,
	}), deployment.isEnabled ? 'デプロイメントを無効化しました' : 'デプロイメントを有効化しました');
}

async function autofillDeploymentFromContract(): Promise<void> {
	deploymentAutofillLoading.value = true;
	deploymentAutofillMessage.value = '';
	error.value = '';
	try {
		const result = await apiPost('/api/admin/resolve-payment-asset-deployment', {
			chainId: deploymentForm.value.chainId,
			contractAddress: deploymentForm.value.contractAddress,
		});
		if (!result.ok) throw new Error(result.data.message);

		deploymentForm.value.decimals = result.data.decimals;
		deploymentForm.value.tokenSymbol = result.data.symbol?.trim() || deploymentForm.value.tokenSymbol;
		deploymentForm.value.tokenName = result.data.name?.trim() || deploymentForm.value.tokenName;
		const tokenLabel = [result.data.symbol, result.data.name].filter(Boolean).join(' / ');
		deploymentAutofillMessage.value = `${tokenLabel || 'Token'} の情報を入力しました。`;
	} catch (e) {
		deploymentAutofillMessage.value = String(e);
	} finally {
		deploymentAutofillLoading.value = false;
	}
}

async function savePrice(): Promise<void> {
	const amountBaseUnits = parseDecimalAmount(priceForm.value.amount, selectedPriceAssetDecimals.value);
	if (amountBaseUnits == null) return;
	await save(async () => apiPost('/api/admin/create-payment-asset-plan-price', {
		assetId: priceForm.value.assetId,
		planId: priceForm.value.planId,
		amountBaseUnits,
		durationDays: priceForm.value.durationDays,
		durationUnit: priceForm.value.durationUnit,
		isEnabled: priceForm.value.isEnabled,
		expiresAt: parseDateTimeLocal(priceForm.value.expiresAt) ?? null,
	}), '価格を作成しました');
}

function openPriceExpiresAtDialog(price: Price): void {
	editingPrice.value = price;
	priceExpiresAtDraft.value = formatDateTimeLocalInput(price.expiresAt);
}

function closePriceExpiresAtDialog(): void {
	editingPrice.value = null;
	priceExpiresAtDraft.value = '';
}

async function updatePriceExpiresAt(price: Price, expiresAt: number | null): Promise<void> {
	await save(async () => apiPost('/api/admin/update-payment-asset-plan-price', {
		priceId: price.id,
		assetId: price.assetId,
		planId: price.plan.id,
		amountBaseUnits: price.amountBaseUnits,
		durationDays: price.durationDays,
		durationUnit: price.durationUnit,
		isEnabled: price.isEnabled,
		expiresAt,
	}), expiresAt == null ? '価格の失効を取り消しました' : '価格の失効日時を保存しました');
	closePriceExpiresAtDialog();
}

async function savePriceExpiresAt(): Promise<void> {
	if (!editingPrice.value) return;
	const expiresAt = parseDateTimeLocal(priceExpiresAtDraft.value);
	if (expiresAt === undefined) {
		error.value = '失効日時が不正です';
		return;
	}
	await updatePriceExpiresAt(editingPrice.value, expiresAt);
}

async function clearPriceExpiresAt(): Promise<void> {
	if (!editingPrice.value) return;
	priceExpiresAtDraft.value = '';
	await updatePriceExpiresAt(editingPrice.value, null);
}

async function expirePriceNow(): Promise<void> {
	if (!editingPrice.value) return;
	const now = Date.now();
	priceExpiresAtDraft.value = formatDateTimeLocalInput(now);
	await updatePriceExpiresAt(editingPrice.value, now);
}

async function saveCryptoPaymentsEnabled(value: 'true' | 'false'): Promise<void> {
	savingSetting.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await apiPost('/api/admin/update-setting', { key: 'crypto_payments_enabled', value });
		if (!result.ok) throw new Error(formatApiError(result.data, '保存に失敗しました'));
		success.value = 'Crypto payments設定を保存しました';
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		savingSetting.value = false;
	}
}

async function save(action: () => Promise<SaveResult>, message: string): Promise<void> {
	saving.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await action();
		if (!result.ok) throw new Error(formatApiError(result.data, '保存に失敗しました'));
		success.value = message;
		await loadAll();
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		saving.value = false;
	}
}

function formatApiError(data: { error?: string; message?: string }, fallback: string): string {
	if (data.error === 'PAYMENT_PRICE_ALREADY_EXISTS') return '同じ通貨・プラン・期間の無期限価格が既にあります。';
	if (data.error === 'PAYMENT_PRICE_ORDER_INVALID') return '同じ通貨・プランでは、長い期間の価格を短い期間より安くできません。';
	return data.message || data.error || fallback;
}

function errorMessage(errorValue: unknown): string {
	return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function formatAmount(amountBaseUnits: string, decimals: number | null, symbol: string): string {
	if (decimals == null) return `${amountBaseUnits} ${symbol}`;
	const padded = amountBaseUnits.padStart(decimals + 1, '0');
	const integer = padded.slice(0, -decimals);
	const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
	return `${integer}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

function getAssetDecimals(assetId: string): number | null {
	return deployments.value.find(deployment => deployment.assetId === assetId)?.decimals ?? DEFAULT_PRICE_DECIMALS;
}

function parseDecimalAmount(value: string, decimals: number): string | null {
	const trimmed = value.trim();
	if (!decimalAmountPattern.test(trimmed)) return null;
	const [integerPart, fractionPart = ''] = trimmed.split('.');
	if (fractionPart.length > decimals) return null;
	const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '');
	const baseUnits = `${normalizedInteger}${fractionPart.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
	return baseUnits === '' ? '0' : baseUnits;
}

function formatDate(value: number | null): string {
	return value == null ? '-' : new Date(value).toLocaleString();
}

function formatDateTimeLocalInput(value: number | null): string {
	if (value == null) return '';
	const date = new Date(value);
	const timezoneOffsetMs = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - timezoneOffsetMs).toISOString().slice(0, 16);
}

function formatPriceStatus(price: Price): string {
	if (!price.isEnabled) return '無効';
	if (price.expiresAt != null && price.expiresAt <= Date.now()) return '失効';
	return '有効';
}

function priceStatusBadgeClass(price: Price): string {
	if (!price.isEnabled) return 'badge-muted';
	if (price.expiresAt != null && price.expiresAt <= Date.now()) return 'badge-danger';
	return 'badge-success';
}

function parseDateTimeLocal(value: string): number | null | undefined {
	const trimmed = value.trim();
	if (trimmed === '') return null;
	const timestamp = new Date(trimmed).getTime();
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function formatDuration(value: number, unit: 'days' | 'months' | 'years'): string {
	const label = unit === 'days' ? '日' : unit === 'months' ? 'ヶ月' : '年';
	return `${value}${label}`;
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
        <SettingItem
          v-model="cryptoPaymentsEnabled"
          :class="['card', $style.settingPanel]"
          :schema="KNOWN_SETTINGS['crypto_payments_enabled']"
          title="Crypto payments"
          :saving="savingSetting"
          :show-save-button="true"
          :save-on-change="false"
          @save="saveCryptoPaymentsEnabled"
        >
          有効にすると、チェーン・RPC・デプロイメント・価格設定が揃っている場合に暗号資産決済を受け付けます。
        </SettingItem>

        <div class="tab-bar" role="tablist" aria-label="Crypto payments">
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'chains' }" role="tab" :aria-selected="activeTab === 'chains'" @click="activeTab = 'chains'">チェーン</button>
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'assets' }" role="tab" :aria-selected="activeTab === 'assets'" @click="activeTab = 'assets'">通貨</button>
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'deployments' }" role="tab" :aria-selected="activeTab === 'deployments'" @click="activeTab = 'deployments'">デプロイメント</button>
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'prices' }" role="tab" :aria-selected="activeTab === 'prices'" @click="activeTab = 'prices'">プラン価格</button>
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'orders' }" role="tab" :aria-selected="activeTab === 'orders'" @click="activeTab = 'orders'">注文</button>
        </div>

        <section v-if="activeTab === 'chains'" :class="$style.section" role="tabpanel">
          <form :class="['card', $style.actionPanel, $style.chainForm]" @submit.prevent="saveChain">
            <div class="form-group">
              <label class="form-label" for="chain-id">Chain ID</label>
              <input id="chain-id" v-model.number="chainForm.chainId" class="form-input" type="number" min="1" :disabled="isEditingChain">
            </div>
            <div :class="$style.autofillControl">
              <button class="btn btn-secondary" type="button" :disabled="chainAutofillLoading" @click="autofillChainFromCatalog">
                {{ chainAutofillLoading ? '検索中...' : '自動入力' }}
              </button>
            </div>
            <div class="form-group">
              <label class="form-label" for="chain-name">Name</label>
              <input id="chain-name" v-model="chainForm.name" class="form-input" type="text">
            </div>
            <div class="form-group">
              <label class="form-label" for="native-currency-name">Native currency</label>
              <input id="native-currency-name" v-model="chainForm.nativeCurrencyName" class="form-input" type="text">
            </div>
            <div class="form-group">
              <label class="form-label" for="native-currency-symbol">Symbol</label>
              <input id="native-currency-symbol" v-model="chainForm.nativeCurrencySymbol" class="form-input" type="text">
            </div>
            <div class="form-group">
              <label class="form-label" for="native-currency-decimals">Decimals</label>
              <input id="native-currency-decimals" v-model.number="chainForm.nativeCurrencyDecimals" class="form-input" type="number" min="0" max="255">
            </div>
            <div class="form-group">
              <label class="form-label" for="block-explorer-url">Explorer URL</label>
              <input id="block-explorer-url" v-model="chainForm.blockExplorerUrl" class="form-input" type="url">
            </div>
            <div class="form-group">
              <label class="form-label" for="confirmations-required">Confirmations</label>
              <input id="confirmations-required" v-model.number="chainForm.confirmationsRequired" class="form-input" type="number" min="1">
            </div>
            <label :class="$style.checkbox"><input v-model="chainForm.isEnabled" type="checkbox">有効</label>
            <button class="btn btn-primary" type="submit" :disabled="saving || !canSaveChain">{{ isEditingChain ? '更新' : '作成' }}</button>
            <button v-if="isEditingChain" class="btn btn-secondary" type="button" :disabled="saving" @click="resetChainForm">キャンセル</button>
            <p v-if="chainAutofillMessage" :class="['text-muted', $style.formMessage]">{{ chainAutofillMessage }}</p>
          </form>
          <div :class="['card', $style.tableCard]">
            <div class="table-responsive">
              <table class="data-table">
                <thead><tr><th>Chain</th><th>RPC</th><th>Confirmations</th><th>状態</th><th class="col-actions">操作</th></tr></thead>
                <tbody>
                  <tr v-for="chain in chains" :key="chain.chainId">
                    <td>{{ chain.name }} ({{ chain.chainId }})</td>
                    <td><span :class="chain.isRpcConfigured ? 'badge badge-success' : 'badge badge-muted'">{{ chain.isRpcConfigured ? '設定済み' : '未設定' }}</span></td>
                    <td>{{ chain.confirmationsRequired }}</td>
                    <td><span :class="['badge', chain.isEnabled ? 'badge-success' : 'badge-muted']">{{ chain.isEnabled ? '有効' : '無効' }}</span></td>
                    <td class="col-actions">
                      <button class="btn btn-secondary" type="button" :disabled="rpcTestingChainId === chain.chainId" @click="testChainRpc(chain)">
                        {{ rpcTestingChainId === chain.chainId ? '確認中...' : 'RPC確認' }}
                      </button>
                      <button class="btn btn-secondary" type="button" @click="startEditChain(chain)">編集</button>
                      <span
                        v-if="rpcTestResults[chain.chainId]"
                        :class="['badge', rpcTestResults[chain.chainId].ok ? 'badge-success' : 'badge-danger', $style.rpcResult]"
                      >
                        {{ rpcTestResults[chain.chainId].message }}
                      </span>
                    </td>
                  </tr>
                  <tr v-if="chains.length === 0"><td colspan="5" :class="$style.empty">チェーンはありません。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section v-else-if="activeTab === 'assets'" :class="$style.section" role="tabpanel">
          <form :class="['card', $style.actionPanel, $style.assetForm]" @submit.prevent="saveAsset">
            <div class="form-group">
              <label class="form-label" for="asset-symbol">Symbol</label>
              <input id="asset-symbol" v-model="assetForm.symbol" class="form-input" type="text">
            </div>
            <div class="form-group">
              <label class="form-label" for="asset-name">Name</label>
              <input id="asset-name" v-model="assetForm.name" class="form-input" type="text">
            </div>
            <label :class="$style.checkbox"><input v-model="assetForm.isEnabled" type="checkbox">有効</label>
            <button class="btn btn-primary" type="submit" :disabled="saving || !canSaveAsset">作成</button>
          </form>
          <div :class="['card', $style.tableCard]">
            <div class="table-responsive">
              <table class="data-table">
                <thead><tr><th>Symbol</th><th>Name</th><th>状態</th><th class="col-actions">操作</th></tr></thead>
                <tbody>
                  <tr v-for="asset in assets" :key="asset.id">
                    <td>{{ asset.symbol }}</td>
                    <td>{{ asset.name }}</td>
                    <td><span :class="['badge', asset.isEnabled ? 'badge-success' : 'badge-muted']">{{ asset.isEnabled ? '有効' : '無効' }}</span></td>
                    <td class="col-actions">
                      <button class="btn btn-secondary btn-sm" type="button" :disabled="saving" @click="toggleAssetEnabled(asset)">
                        {{ asset.isEnabled ? '無効化' : '有効化' }}
                      </button>
                    </td>
                  </tr>
                  <tr v-if="assets.length === 0"><td colspan="4" :class="$style.empty">通貨はありません。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section v-else-if="activeTab === 'deployments'" :class="$style.section" role="tabpanel">
          <form :class="['card', $style.actionPanel, $style.deploymentForm]" @submit.prevent="saveDeployment">
            <div class="form-group">
              <label class="form-label" for="deployment-asset">Asset</label>
              <select id="deployment-asset" v-model="deploymentForm.assetId" class="form-input">
                <option v-for="asset in assets" :key="asset.id" :value="asset.id">{{ asset.symbol }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="deployment-chain">Chain</label>
              <select id="deployment-chain" v-model.number="deploymentForm.chainId" class="form-input">
                <option v-for="chain in chains" :key="chain.chainId" :value="chain.chainId">{{ chain.name }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="contract-address">Contract address</label>
              <input id="contract-address" v-model="deploymentForm.contractAddress" class="form-input form-input-mono" type="text" :disabled="isEditingDeployment">
            </div>
            <div :class="$style.autofillControl">
              <button class="btn btn-secondary" type="button" :disabled="deploymentAutofillLoading || !deploymentForm.contractAddress" @click="autofillDeploymentFromContract">
                {{ deploymentAutofillLoading ? '検索中...' : '自動入力' }}
              </button>
            </div>
            <div class="form-group">
              <label class="form-label" for="deployment-token-symbol">Token symbol</label>
              <input id="deployment-token-symbol" v-model="deploymentForm.tokenSymbol" class="form-input" type="text">
            </div>
            <div class="form-group">
              <label class="form-label" for="deployment-token-name">Token name</label>
              <input id="deployment-token-name" v-model="deploymentForm.tokenName" class="form-input" type="text">
            </div>
            <div class="form-group">
              <label class="form-label" for="deployment-decimals">Decimals</label>
              <input id="deployment-decimals" v-model.number="deploymentForm.decimals" class="form-input" type="number" min="0" max="255">
            </div>
            <div class="form-group">
              <label class="form-label" for="recipient-address">Recipient address</label>
              <input id="recipient-address" v-model="deploymentForm.recipientAddress" class="form-input form-input-mono" type="text">
            </div>
            <label :class="$style.checkbox"><input v-model="deploymentForm.isEnabled" type="checkbox">有効</label>
            <button class="btn btn-primary" type="submit" :disabled="saving || !canSaveDeployment">{{ isEditingDeployment ? '更新' : '作成' }}</button>
            <button v-if="isEditingDeployment" class="btn btn-secondary" type="button" :disabled="saving" @click="resetDeploymentForm">キャンセル</button>
            <p v-if="deploymentAutofillMessage" :class="['text-muted', $style.formMessage]">{{ deploymentAutofillMessage }}</p>
          </form>
          <div :class="['card', $style.tableCard]">
            <div class="table-responsive">
              <table class="data-table">
                <thead><tr><th>Asset</th><th>Token</th><th>Chain</th><th>Contract</th><th>Recipient</th><th>RPC</th><th>状態</th><th class="col-actions">操作</th></tr></thead>
                <tbody>
                  <tr v-for="deployment in deployments" :key="deployment.id">
                    <td>{{ deployment.assetSymbol }}</td>
                    <td>{{ deployment.tokenSymbol }}</td>
                    <td>{{ deployment.chainName }}</td>
                    <td><code>{{ deployment.contractAddress }}</code></td>
                    <td><code>{{ deployment.recipientAddress }}</code></td>
                    <td>{{ deployment.isRpcConfigured ? '設定済み' : '未設定' }}</td>
                    <td><span :class="['badge', deployment.isEnabled ? 'badge-success' : 'badge-muted']">{{ deployment.isEnabled ? '有効' : '無効' }}</span></td>
                    <td class="col-actions">
                      <button class="btn btn-secondary btn-sm" type="button" :disabled="saving" @click="startEditDeployment(deployment)">編集</button>
                      <button class="btn btn-secondary btn-sm" type="button" :disabled="saving" @click="toggleDeploymentEnabled(deployment)">
                        {{ deployment.isEnabled ? '無効化' : '有効化' }}
                      </button>
                    </td>
                  </tr>
                  <tr v-if="deployments.length === 0"><td colspan="8" :class="$style.empty">デプロイメントはありません。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section v-else-if="activeTab === 'prices'" :class="$style.section" role="tabpanel">
          <form :class="['card', $style.actionPanel, $style.priceForm]" @submit.prevent="savePrice">
            <div class="form-group">
              <label class="form-label" for="price-asset">Asset</label>
              <select id="price-asset" v-model="priceForm.assetId" class="form-input">
                <option v-for="asset in assets" :key="asset.id" :value="asset.id">{{ asset.symbol }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="price-plan">Plan</label>
              <select id="price-plan" v-model="priceForm.planId" class="form-input">
                <option v-for="plan in plans" :key="plan.id" :value="plan.id">{{ plan.name }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="amount">Amount</label>
              <input id="amount" v-model="priceForm.amount" class="form-input form-input-mono" type="text" placeholder="30.5">
            </div>
            <div class="form-group">
              <label class="form-label" for="duration-days">Duration</label>
              <input id="duration-days" v-model.number="priceForm.durationDays" class="form-input" type="number" min="1">
            </div>
            <div class="form-group">
              <label class="form-label" for="duration-unit">Unit</label>
              <select id="duration-unit" v-model="priceForm.durationUnit" class="form-input">
                <option value="days">日</option>
                <option value="months">ヶ月</option>
                <option value="years">年</option>
              </select>
            </div>
            <label :class="$style.checkbox"><input v-model="priceForm.isEnabled" type="checkbox">有効</label>
            <div class="form-group">
              <label class="form-label" for="price-expires-at">Expires at</label>
              <input id="price-expires-at" v-model="priceForm.expiresAt" class="form-input" type="datetime-local">
            </div>
            <button class="btn btn-primary" type="submit" :disabled="saving || !canSavePrice">作成</button>
          </form>
          <div :class="['card', $style.tableCard]">
            <div class="table-responsive">
              <table class="data-table">
                <thead><tr><th>Offer</th><th>価格</th><th>期間</th><th>失効日時</th><th>状態</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="price in prices" :key="price.id">
                    <td>{{ price.plan.name }} / {{ price.assetSymbol }}</td>
                    <td>{{ formatAmount(price.amountBaseUnits, price.decimals ?? getAssetDecimals(price.assetId), price.assetSymbol) }}</td>
                    <td>{{ formatDuration(price.durationDays, price.durationUnit) }}</td>
                    <td>{{ formatDate(price.expiresAt) }}</td>
                    <td><span :class="['badge', priceStatusBadgeClass(price)]">{{ formatPriceStatus(price) }}</span></td>
                    <td :class="$style.rowActions">
                      <button class="btn btn-secondary btn-sm" type="button" :disabled="saving" @click="openPriceExpiresAtDialog(price)">失効設定</button>
                    </td>
                  </tr>
                  <tr v-if="prices.length === 0"><td colspan="6" :class="$style.empty">プラン価格はありません。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section v-else-if="activeTab === 'orders'" :class="$style.section" role="tabpanel">
          <div :class="['card', $style.tableCard]">
            <div class="table-responsive">
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
                  <tr v-if="orders.length === 0"><td colspan="6" :class="$style.empty">注文はありません。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      <Dialog.Root :model-value="editingPrice != null" @update:model-value="(value) => { if (!value) closePriceExpiresAtDialog(); }">
        <Dialog.Content :class="$style.dialog">
          <form v-if="editingPrice" :class="$style.dialogInner" @submit.prevent="savePriceExpiresAt">
            <div :class="$style.dialogHeader">
              <Dialog.Title :class="$style.dialogTitle">価格の失効設定</Dialog.Title>
              <button class="btn btn-ghost btn-sm" type="button" @click="closePriceExpiresAtDialog">閉じる</button>
            </div>
            <div v-if="error" class="alert alert-error">{{ error }}</div>
            <div :class="$style.dialogSummary">
              <div>{{ editingPrice.plan.name }} / {{ editingPrice.assetSymbol }}</div>
              <div>{{ formatAmount(editingPrice.amountBaseUnits, editingPrice.decimals ?? getAssetDecimals(editingPrice.assetId), editingPrice.assetSymbol) }} / {{ formatDuration(editingPrice.durationDays, editingPrice.durationUnit) }}</div>
            </div>
            <div class="form-group">
              <label class="form-label" for="edit-price-expires-at">失効日時</label>
              <input id="edit-price-expires-at" v-model="priceExpiresAtDraft" class="form-input" type="datetime-local">
            </div>
            <div :class="$style.dialogActions">
              <button class="btn btn-primary" type="submit" :disabled="saving">保存</button>
              <button class="btn btn-secondary" type="button" :disabled="saving" @click="expirePriceNow">今すぐ失効</button>
              <button class="btn btn-secondary" type="button" :disabled="saving || editingPrice.expiresAt == null" @click="clearPriceExpiresAt">失効取り消し</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Root>

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
  gap: 16px;
}

.actionPanel {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
  margin-bottom: 0;

  :global(.form-group) {
    flex: 1 1 180px;
    min-width: 0;
  }

  :global(.form-input) {
    width: 100%;
  }

  > button,
  > .checkbox,
  > .autofillControl {
    flex: 0 0 auto;
  }
}

.settingPanel {
  max-width: none;
}

.chainForm {
  :global(.form-group) {
    flex-basis: 160px;
  }
}

.assetForm {
  :global(.form-group) {
    flex-basis: 180px;
  }
}

.deploymentForm {
  :global(.form-group) {
    flex-basis: 190px;
  }
}

.priceForm {
  :global(.form-group) {
    flex-basis: 160px;
  }
}

.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  color: var(--color-text);
  white-space: nowrap;
}

.autofillControl {
  display: flex;
  align-items: end;
  min-height: 62px;
}

.formMessage {
  flex-basis: 100%;
  margin: 0;
}

.rpcResult {
  margin-left: 6px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  white-space: nowrap;
}

.tableCard {
  padding: 0;
  overflow: hidden;
}

.rowActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 96px;
}

.empty {
  color: var(--color-text-muted);
  text-align: center;
}

.dialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  width: min(440px, calc(100vw - 32px));

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.dialogInner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
}

.dialogHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dialogTitle {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
}

.dialogSummary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--color-text-muted);
  font-size: 0.92rem;
}

.dialogActions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 720px) {
  .actionPanel {
    align-items: stretch;

    :global(.form-group),
    > button,
    > .checkbox,
    > .autofillControl {
      flex-basis: 100%;
    }
  }
}
</style>
