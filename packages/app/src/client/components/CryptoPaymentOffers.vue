<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Dialog } from '@vuetify/v0';
import { encodeFunctionData } from 'viem';
import { apiPost, type ApiSuccess } from '@/utils/api';
import { useWallet } from '@/composables/useWallet';
import WalletSettings from '@/components/WalletSettings.vue';

type Offer = ApiSuccess<'/api/billing/list-crypto-offers'>['data'][number];
type LinkedWallet = ApiSuccess<'/api/account/wallets/list'>['data'][number];
type CurrentPlan = ApiSuccess<'/api/account/current-plan'>['data'];
type PaymentAssetOption = {
	id: string;
	symbol: string;
	name: string;
};
type PaymentTokenOption = {
	deploymentId: string;
	symbol: string;
	name: string;
	chainName: string | null;
	contractAddress: string;
};
type PurchasePrice = {
	id: string;
	offers: Offer[];
	representativeOffer: Offer;
};
type PurchasePlan = {
	id: string;
	plan: Offer['plan'];
	prices: PurchasePrice[];
};
type ChainCatalogEntry = {
	id: number;
	name: string;
	nativeCurrency: {
		name: string;
		symbol: string;
		decimals: number;
	};
	rpcUrls: {
		default: {
			http: string[];
		};
	};
	blockExplorers?: {
		default: {
			url: string;
		};
	};
};

const props = defineProps<{
	reloadKey?: number;
}>();

const emit = defineEmits<{
	purchased: [];
}>();

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

const offers = ref<Offer[]>([]);
const wallets = ref<LinkedWallet[]>([]);
const currentPlan = ref<CurrentPlan>(null);
const cryptoPaymentsEnabled = ref(false);
const loading = ref(true);
const buyingOfferId = ref<string | null>(null);
const addingTokenOfferId = ref<string | null>(null);
const selectedAssetId = ref<string | null>(null);
const selectedFilterDeploymentId = ref<string | null>(null);
const selectedPurchasePriceId = ref<string | null>(null);
const selectedDialogDeploymentId = ref<string | null>(null);
const error = ref('');
const success = ref('');
const walletSetupMode = ref(false);
const {
	walletAddress,
	walletChainId,
	connectWallet,
	switchOrAddWalletChain,
	watchWalletAsset,
	sendWalletTransaction,
	waitForWalletTransactionReceipt,
} = useWallet();

const hasLinkedWallets = computed(() => wallets.value.length > 0);
const paymentAssetOptions = computed<PaymentAssetOption[]>(() => {
	const assetMap = new Map<string, PaymentAssetOption>();
	for (const offer of offers.value) {
		if (!isOfferDisplayable(offer)) continue;
		if (!assetMap.has(offer.assetId)) {
			assetMap.set(offer.assetId, {
				id: offer.assetId,
				symbol: offer.assetSymbol,
				name: offer.assetName,
			});
		}
	}
	return [...assetMap.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
});
const filterPaymentTokenOptions = computed<PaymentTokenOption[]>(() => {
	if (selectedAssetId.value == null) return [];
	const tokenMap = new Map<string, PaymentTokenOption>();
	for (const offer of offers.value) {
		if (
			isOfferDisplayable(offer)
			&& offer.assetId === selectedAssetId.value
			&& offer.deploymentId != null
			&& offer.tokenSymbol != null
			&& offer.tokenName != null
			&& offer.contractAddress != null
		) {
			tokenMap.set(offer.deploymentId, {
				deploymentId: offer.deploymentId,
				symbol: offer.tokenSymbol,
				name: offer.tokenName,
				chainName: offer.chainName,
				contractAddress: offer.contractAddress,
			});
		}
	}
	return [...tokenMap.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || (a.chainName ?? '').localeCompare(b.chainName ?? ''));
});
const selectedFilterPaymentToken = computed(() => filterPaymentTokenOptions.value.find(token => token.deploymentId === selectedFilterDeploymentId.value) ?? null);
const selectedFilterTokenOffer = computed(() => offers.value.find(offer => (
	isOfferDisplayable(offer)
	&& offer.assetId === selectedAssetId.value
	&& offer.deploymentId === selectedFilterDeploymentId.value
	&& offer.chainId != null
	&& offer.contractAddress != null
	&& offer.decimals != null
)) ?? null);
const purchasePlans = computed<PurchasePlan[]>(() => {
	const planMap = new Map<string, PurchasePlan>();
	for (const offer of offers.value) {
		if (!isOfferDisplayable(offer)) continue;
		if (selectedAssetId.value != null && offer.assetId !== selectedAssetId.value) continue;
		const plan = planMap.get(offer.plan.id) ?? {
			id: offer.plan.id,
			plan: offer.plan,
			prices: [],
		};
		if (!planMap.has(offer.plan.id)) planMap.set(offer.plan.id, plan);

		let price = plan.prices.find(item => item.id === offer.id);
		if (!price) {
			price = {
				id: offer.id,
				offers: [],
				representativeOffer: offer,
			};
			plan.prices.push(price);
		}
		price.offers.push(offer);
	}
	return [...planMap.values()].map(plan => ({
		...plan,
		prices: [...plan.prices].sort((a, b) => (
			compareOfferDuration(a.representativeOffer, b.representativeOffer)
			|| compareBigIntString(a.representativeOffer.amountBaseUnits, b.representativeOffer.amountBaseUnits)
			|| a.representativeOffer.id.localeCompare(b.representativeOffer.id)
		)),
	})).sort((a, b) => (
		a.plan.sortOrder - b.plan.sortOrder
		|| a.plan.name.localeCompare(b.plan.name)
		|| a.id.localeCompare(b.id)
	));
});
const selectedPurchasePrice = computed(() => {
	if (selectedPurchasePriceId.value == null) return null;
	for (const plan of purchasePlans.value) {
		const price = plan.prices.find(item => item.id === selectedPurchasePriceId.value);
		if (price) return price;
	}
	return null;
});
const paymentTokenOptions = computed<PaymentTokenOption[]>(() => {
	if (!selectedPurchasePrice.value) return [];
	const tokenMap = new Map<string, PaymentTokenOption>();
	for (const offer of selectedPurchasePrice.value.offers) {
		if (
			offer.deploymentId != null
			&& offer.tokenSymbol != null
			&& offer.tokenName != null
			&& offer.contractAddress != null
		) {
			const key = offer.deploymentId;
			tokenMap.set(key, {
				deploymentId: offer.deploymentId,
				symbol: offer.tokenSymbol,
				name: offer.tokenName,
				chainName: offer.chainName,
				contractAddress: offer.contractAddress,
			});
		}
	}
	return [...tokenMap.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || (a.chainName ?? '').localeCompare(b.chainName ?? ''));
});
const selectedPaymentToken = computed(() => paymentTokenOptions.value.find(token => token.deploymentId === selectedDialogDeploymentId.value) ?? null);
const selectedDialogOffer = computed(() => selectedPurchasePrice.value?.offers.find(offer => offer.deploymentId === selectedDialogDeploymentId.value) ?? null);
const selectedTokenOffer = computed(() => selectedDialogOffer.value && (
	selectedDialogOffer.value.chainId != null
	&& selectedDialogOffer.value.contractAddress != null
	&& selectedDialogOffer.value.decimals != null
) ? selectedDialogOffer.value : null);
const purchaseDialogOpen = computed(() => selectedPurchasePrice.value != null);
const selectedDialogCanBuy = computed(() => selectedDialogOffer.value != null
	&& selectedDialogOffer.value.isRpcConfigured
	&& selectedDialogOffer.value.chainId != null
	&& walletAddress.value != null
	&& connectedWalletForOffer(selectedDialogOffer.value) != null);
const selectedTokenOfferForRegistration = computed(() => selectedPurchasePrice.value?.offers.find(offer => (
	offer.deploymentId === selectedDialogDeploymentId.value
	&& offer.chainId != null
	&& offer.contractAddress != null
	&& offer.decimals != null
)) ?? null);

function hasConnectedLinkedWallet(): boolean {
	const address = walletAddress.value;
	if (!address || walletChainId.value == null) return false;
	return wallets.value.some(wallet => wallet.chainId === walletChainId.value && wallet.address.toLowerCase() === address.toLowerCase());
}

async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const [metaResult, walletsResult, currentPlanResult] = await Promise.all([
			fetch('/api/meta'),
			apiPost('/api/account/wallets/list'),
			apiPost('/api/account/current-plan'),
		]);
		if (!metaResult.ok) {
			error.value = 'メタ情報の取得に失敗しました';
			return;
		}
		if (!walletsResult.ok) {
			error.value = walletsResult.data.message || 'ウォレット連携情報の取得に失敗しました';
			return;
		}
		if (!currentPlanResult.ok) {
			error.value = currentPlanResult.data.message || 'プランの取得に失敗しました';
			return;
		}
		const meta = await metaResult.json() as { cryptoPaymentsEnabled?: boolean };
		cryptoPaymentsEnabled.value = meta.cryptoPaymentsEnabled ?? false;
		wallets.value = walletsResult.data;
		currentPlan.value = currentPlanResult.data;
		if (!walletSetupMode.value && !hasConnectedLinkedWallet()) walletSetupMode.value = true;

		if (!cryptoPaymentsEnabled.value) {
			offers.value = [];
			return;
		}

		const offersResult = await apiPost('/api/billing/list-crypto-offers');
		if (!offersResult.ok) {
			error.value = offersResult.data.message || '購入プランの取得に失敗しました';
			return;
		}
		offers.value = offersResult.data;
		syncPaymentSelection();
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

function syncPaymentSelection(): void {
	if (paymentAssetOptions.value.length === 0) {
		selectedAssetId.value = null;
		selectedFilterDeploymentId.value = null;
		closePurchaseDialog();
		return;
	}
	if (selectedAssetId.value == null || !paymentAssetOptions.value.some(asset => asset.id === selectedAssetId.value)) {
		selectedAssetId.value = paymentAssetOptions.value[0]?.id ?? null;
	}
	if (
		selectedFilterDeploymentId.value == null
		|| !filterPaymentTokenOptions.value.some(token => token.deploymentId === selectedFilterDeploymentId.value)
	) {
		selectedFilterDeploymentId.value = filterPaymentTokenOptions.value[0]?.deploymentId ?? null;
	}
	if (
		selectedPurchasePriceId.value != null
		&& !purchasePlans.value.some(plan => plan.prices.some(price => price.id === selectedPurchasePriceId.value))
	) {
		closePurchaseDialog();
	}
	if (selectedPurchasePrice.value && (
		selectedDialogDeploymentId.value == null
		|| !paymentTokenOptions.value.some(token => token.deploymentId === selectedDialogDeploymentId.value)
	)) {
		selectedDialogDeploymentId.value = paymentTokenOptions.value[0]?.deploymentId ?? null;
	}
}

function selectPaymentAsset(assetId: string): void {
	selectedAssetId.value = assetId || null;
	selectedFilterDeploymentId.value = filterPaymentTokenOptions.value[0]?.deploymentId ?? null;
	closePurchaseDialog();
}

function openPurchaseDialog(price: PurchasePrice): void {
	selectedPurchasePriceId.value = price.id;
	if (
		selectedDialogDeploymentId.value == null
		|| !price.offers.some(offer => offer.deploymentId === selectedDialogDeploymentId.value)
	) {
		selectedDialogDeploymentId.value = price.offers.find(offer => offer.deploymentId === selectedFilterDeploymentId.value)?.deploymentId
			?? price.offers.find(offer => offer.deploymentId != null)?.deploymentId
			?? null;
	}
}

function closePurchaseDialog(): void {
	selectedPurchasePriceId.value = null;
	selectedDialogDeploymentId.value = null;
}

function onPurchaseDialogOpenChange(value: boolean): void {
	if (!value) closePurchaseDialog();
}

function purchasePriceForOffer(offer: Offer): PurchasePrice {
	return {
		id: offer.id,
		representativeOffer: offer,
		offers: [offer],
	};
}

function durationSortValue(value: number, unit: 'days' | 'months' | 'years'): number {
	const date = new Date(Date.UTC(2024, 0, 1));
	if (unit === 'days') date.setUTCDate(date.getUTCDate() + value);
	if (unit === 'months') date.setUTCMonth(date.getUTCMonth() + value);
	if (unit === 'years') date.setUTCFullYear(date.getUTCFullYear() + value);
	return date.getTime();
}

function compareOfferDuration(a: Offer, b: Offer): number {
	return durationSortValue(a.durationDays, a.durationUnit) - durationSortValue(b.durationDays, b.durationUnit);
}

function compareBigIntString(a: string, b: string): number {
	const aValue = BigInt(a);
	const bValue = BigInt(b);
	return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
}

function buySelectedOffer(): void {
	if (!selectedDialogOffer.value) return;
	void buyOffer(selectedDialogOffer.value);
}

function addSelectedTokenToWallet(): void {
	if (!selectedTokenOfferForRegistration.value) return;
	void addOfferTokenToWallet(selectedTokenOfferForRegistration.value);
}

function addFilterTokenToWallet(): void {
	if (!selectedFilterTokenOffer.value) return;
	void addOfferTokenToWallet(selectedFilterTokenOffer.value);
}

function formatNumberQuota(value: number | null): string {
	return value == null ? '無制限' : value.toLocaleString();
}

function formatBytesQuota(value: number | null): string {
	if (value == null) return '無制限';
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GiB`;
	if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
	if (value >= 1024) return `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
	return `${value.toLocaleString()} B`;
}

function formatAmountValue(amountBaseUnits: string, decimals: number | null): string {
	if (decimals == null) return amountBaseUnits;
	const padded = amountBaseUnits.padStart(decimals + 1, '0');
	const integer = padded.slice(0, -decimals);
	const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
	return integer + (fraction ? `.${fraction}` : '');
}

function formatOfferAmountValue(offer: Offer): string {
	return formatAmountValue(offer.quote.payableAmountBaseUnits, offer.decimals);
}

function formatOfferAmount(offer: Offer, amountBaseUnits: string): string {
	return formatAmount(amountBaseUnits, offer.decimals, offer.tokenSymbol ?? offer.assetSymbol);
}

function dialogDiscountFormula(): string {
	const offer = selectedDialogOffer.value;
	if (!offer) return '-';
	return `${formatOfferAmount(offer, offer.quote.baseAmountBaseUnits)} - ${formatOfferAmount(offer, offer.quote.discountBaseUnits)} = ${formatOfferAmount(offer, offer.quote.payableAmountBaseUnits)}`;
}

function dialogPayableAmount(): string {
	const offer = selectedDialogOffer.value;
	return offer ? formatOfferAmount(offer, offer.quote.payableAmountBaseUnits) : '-';
}

function dialogTokenName(): string {
	const offer = selectedDialogOffer.value;
	if (!offer) return '-';
	const symbol = offer.tokenSymbol ?? offer.assetSymbol;
	const name = offer.tokenName ?? offer.assetName;
	return symbol === name ? symbol : `${name} (${symbol})`;
}

function dialogChainName(): string {
	return selectedDialogOffer.value?.chainName ?? '-';
}

function dialogTitle(): string {
	const offer = selectedDialogOffer.value;
	return offer ? `${offer.plan.name} +${formatDuration(offer.durationDays, offer.durationUnit)}` : '';
}

function isOfferDisplayable(offer: Offer): boolean {
	return offer.isEnabled && (offer.expiresAt == null || offer.expiresAt > Date.now());
}

function isCurrentPlan(plan: Offer['plan']): boolean {
	return currentPlan.value != null
		&& currentPlan.value.planId === plan.id
		&& currentPlan.value.expiresAt > Date.now();
}

function dialogExpiryBefore(): number | null {
	const offer = selectedDialogOffer.value;
	if (!offer) return null;
	if (isCurrentPlan(offer.plan) && currentPlan.value) return currentPlan.value.expiresAt;
	return offer.quote.currentPlan?.expiresAt ?? null;
}

function dialogExpiryAfter(): number | null {
	return selectedDialogOffer.value?.quote.effectiveExpiresAt ?? null;
}

function tokenStatusText(): string {
	return selectedDialogOffer.value?.isRpcConfigured ? '設定済み' : '未設定';
}

function payerStatusText(): string {
	if (!walletAddress.value) return 'ウォレット未接続';
	if (selectedDialogOffer.value && connectedWalletForOffer(selectedDialogOffer.value)) return '連携済み';
	return 'このチェーンでは未連携';
}

function dialogPurchaseButtonLabel(): string {
	const offer = selectedDialogOffer.value;
	return offer && buyingOfferId.value === offer.id ? '処理中...' : '購入';
}

function dialogRegisterButtonLabel(): string {
	const offer = selectedTokenOfferForRegistration.value;
	return offer && addingTokenOfferId.value === offer.id ? '登録中...' : `${selectedPaymentToken.value?.symbol ?? 'Token'}をウォレットに登録`;
}

function filterRegisterButtonLabel(): string {
	const offer = selectedFilterTokenOffer.value;
	return offer && addingTokenOfferId.value === offer.id ? '登録中...' : `${selectedFilterPaymentToken.value?.symbol ?? 'Token'}をウォレットに登録`;
}

function canRegisterSelectedToken(): boolean {
	const offer = selectedTokenOfferForRegistration.value;
	return buyingOfferId.value === null
		&& addingTokenOfferId.value === null
		&& offer != null
		&& offer.isRpcConfigured;
}

function canRegisterFilterToken(): boolean {
	const offer = selectedFilterTokenOffer.value;
	return buyingOfferId.value === null
		&& addingTokenOfferId.value === null
		&& offer != null
		&& offer.isRpcConfigured;
}

function canBuySelectedOffer(): boolean {
	return buyingOfferId.value === null && selectedDialogCanBuy.value;
}

function formatDateOrDash(value: number | null): string {
	return value == null ? '-' : formatDate(value);
}

function firstPriceOffer(price: PurchasePrice): Offer {
	return price.representativeOffer;
}

function selectedFilterOfferForPrice(price: PurchasePrice): Offer {
	return price.offers.find(offer => offer.deploymentId === selectedFilterDeploymentId.value) ?? price.representativeOffer;
}

function currentPlanBadgeVisible(plan: Offer['plan']): boolean {
	return isCurrentPlan(plan);
}

function planQuotaItems(plan: Offer['plan']): Array<{ label: string; value: string }> {
	return [
		{ label: 'バケット', value: formatNumberQuota(plan.maxBuckets) },
		{ label: '容量', value: formatBytesQuota(plan.maxBucketSizeBytes) },
		{ label: 'ファイル', value: formatNumberQuota(plan.maxFilesPerBucket) },
		{ label: '日次アップロード', value: formatNumberQuota(plan.maxDailyUploads) },
	];
}

function priceRowKey(price: PurchasePrice): string {
	return price.id;
}

function priceButtonDisabled(price: PurchasePrice): boolean {
	return buyingOfferId.value !== null || price.offers.length === 0;
}

function openPriceDialog(price: PurchasePrice): void {
	openPurchaseDialog(price);
}

function fallbackPurchaseFromOffer(offer: Offer): void {
	openPurchaseDialog(purchasePriceForOffer(offer));
}

function syncDialogTokenAfterSelection(): void {
	if (selectedDialogDeploymentId.value == null && paymentTokenOptions.value[0]) {
		selectedDialogDeploymentId.value = paymentTokenOptions.value[0].deploymentId;
	}
}

watch(paymentTokenOptions, () => {
	syncDialogTokenAfterSelection();
});

async function handleWalletReady(): Promise<void> {
	await load();
	walletSetupMode.value = false;
}

function offerKey(offer: Offer): string {
	return `${offer.id}:${offer.deploymentId ?? 'asset'}`;
}

function walletsForOffer(offer: Offer): LinkedWallet[] {
	return offer.chainId == null ? [] : wallets.value.filter(wallet => wallet.chainId === offer.chainId);
}

function connectedWalletForOffer(offer: Offer, address = walletAddress.value): LinkedWallet | null {
	if (!address) return null;
	return walletsForOffer(offer).find(wallet => wallet.address.toLowerCase() === address.toLowerCase()) ?? null;
}

function isChainCatalogEntry(value: unknown): value is ChainCatalogEntry {
	if (typeof value !== 'object' || value === null) return false;
	const maybeChain = value as {
		id?: unknown;
		name?: unknown;
		nativeCurrency?: { name?: unknown; symbol?: unknown; decimals?: unknown };
		rpcUrls?: { default?: { http?: unknown } };
	};
	return typeof maybeChain.id === 'number'
		&& typeof maybeChain.name === 'string'
		&& typeof maybeChain.nativeCurrency === 'object'
		&& maybeChain.nativeCurrency !== null
		&& typeof maybeChain.nativeCurrency.name === 'string'
		&& typeof maybeChain.nativeCurrency.symbol === 'string'
		&& typeof maybeChain.nativeCurrency.decimals === 'number'
		&& typeof maybeChain.rpcUrls === 'object'
		&& maybeChain.rpcUrls !== null
		&& typeof maybeChain.rpcUrls.default === 'object'
		&& maybeChain.rpcUrls.default !== null
		&& Array.isArray(maybeChain.rpcUrls.default.http)
		&& maybeChain.rpcUrls.default.http.every(url => typeof url === 'string');
}

async function switchOrAddOfferChain(offer: Offer): Promise<void> {
	if (offer.chainId == null) throw new Error('このプランで利用できるチェーンがありません');
	const chainCatalog = await import('viem/chains') as Record<string, unknown>;
	const catalogChain = Object.values(chainCatalog)
		.find((value): value is ChainCatalogEntry => isChainCatalogEntry(value) && value.id === offer.chainId);
	if (!catalogChain) throw new Error(`chain ${offer.chainId} は viem/chains に見つかりません`);
	await switchOrAddWalletChain({
		chainId: offer.chainId,
		name: offer.chainName ?? catalogChain.name,
		nativeCurrencyName: catalogChain.nativeCurrency.name,
		nativeCurrencySymbol: catalogChain.nativeCurrency.symbol,
		nativeCurrencyDecimals: catalogChain.nativeCurrency.decimals,
		rpcUrls: catalogChain.rpcUrls.default.http,
		blockExplorerUrl: catalogChain.blockExplorers?.default.url ?? null,
	});
}

async function addOfferTokenToWallet(offer: Offer): Promise<boolean> {
	error.value = '';
	success.value = '';
	addingTokenOfferId.value = offer.id;
	try {
		if (offer.chainId == null || offer.contractAddress == null || offer.decimals == null) {
			throw new Error('このプランのトークン情報が不足しています');
		}
		await connectWallet();
		await switchOrAddOfferChain(offer);
		return await watchWalletAsset({
			address: offer.contractAddress as `0x${string}`,
			symbol: offer.tokenSymbol ?? offer.assetSymbol,
			decimals: offer.decimals,
		});
	} catch (e) {
		error.value = String(e);
		return false;
	} finally {
		addingTokenOfferId.value = null;
	}
}

async function buyOffer(offer: Offer): Promise<void> {
	buyingOfferId.value = offer.id;
	error.value = '';
	success.value = '';
	try {
		if (offer.deploymentId == null || offer.chainId == null || offer.contractAddress == null || offer.recipientAddress == null || offer.confirmationsRequired == null) {
			throw new Error('このプランで利用できるチェーンがありません');
		}
		const from = walletAddress.value ?? (await connectWallet()).address;
		const wallet = connectedWalletForOffer(offer, from);
		if (!wallet) throw new Error('接続中ウォレットはこのチェーンで連携されていません。ウォレットタブで連携するか、ウォレット側でアカウントを切り替えてください。');
		await switchOrAddOfferChain(offer);
		const orderResult = await apiPost('/api/billing/create-crypto-order', {
			priceId: offer.id,
			deploymentId: offer.deploymentId,
			payerWalletId: wallet.id,
			quotedAmountBaseUnits: offer.quote.payableAmountBaseUnits,
			quoteCreatedAt: offer.quote.quoteCreatedAt,
		});
		if (!orderResult.ok) throw new Error(orderResult.data.message);
		const txHash = await sendTokenTransfer(from, orderResult.data.contractAddress, orderResult.data.recipientAddress, orderResult.data.amountBaseUnits, offer.chainId);
		await waitForTransactionConfirmations(txHash, offer.chainId, Math.max(1, offer.confirmationsRequired));
		const confirmResult = await apiPost('/api/billing/confirm-crypto-order', { orderId: orderResult.data.id, txHash });
			if (!confirmResult.ok) throw new Error(confirmResult.data.message);
			success.value = '決済を確認し、プランを反映しました';
			closePurchaseDialog();
			await load();
		emit('purchased');
	} catch (e) {
		emit('purchased');
		error.value = String(e);
	} finally {
		buyingOfferId.value = null;
	}
}

async function sendTokenTransfer(from: string, contractAddress: string, recipientAddress: string, amountBaseUnits: string, chainId: number): Promise<`0x${string}`> {
	const data = encodeFunctionData({
		abi: erc20Abi,
		functionName: 'transfer',
		args: [recipientAddress as `0x${string}`, BigInt(amountBaseUnits)],
	});
	const txHash = await sendWalletTransaction({
		account: from as `0x${string}`,
		chainId,
		to: contractAddress as `0x${string}`,
		data,
		value: 0n,
	});
	if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('txHash の取得に失敗しました');
	return txHash as `0x${string}`;
}

async function waitForTransactionConfirmations(txHash: `0x${string}`, chainId: number, confirmationsRequired: number): Promise<void> {
	await waitForWalletTransactionReceipt(txHash, {
		chainId,
		confirmations: confirmationsRequired,
		pollingInterval: RECEIPT_POLL_INTERVAL_MS,
		timeout: RECEIPT_TIMEOUT_MS,
	});
}

function formatAmount(amountBaseUnits: string, decimals: number | null, symbol: string): string {
	if (decimals == null) return `${amountBaseUnits} ${symbol}`;
	const padded = amountBaseUnits.padStart(decimals + 1, '0');
	const integer = padded.slice(0, -decimals);
	const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
	return `${integer}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

function formatDuration(value: number, unit: 'days' | 'months' | 'years'): string {
	const label = unit === 'days' ? '日' : unit === 'months' ? 'ヶ月' : '年';
	return `${value}${label}`;
}

function formatDate(value: number): string {
	return new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(value));
}

function isCurrentPlanOffer(offer: Offer): boolean {
	return currentPlan.value != null
		&& currentPlan.value.planId === offer.plan.id
		&& currentPlan.value.expiresAt > Date.now();
}

watch(() => props.reloadKey, () => {
	void load();
});

onMounted(load);
</script>

<template>
  <div>
    <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
    <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>
    <div v-if="loading" class="page-loading">
      <span class="spinner" />読み込み中...
    </div>
    <template v-else>
      <div v-if="!cryptoPaymentsEnabled" class="alert alert-info">暗号資産決済は現在利用できません。</div>
	      <div v-else-if="offers.length === 0" class="text-muted">購入可能なプランはありません。</div>
	      <div v-else-if="walletSetupMode">
	        <WalletSettings @changed="load" @ready="handleWalletReady" />
	      </div>
	      <template v-else>
	        <div :class="$style.purchaseStack">
	          <div :class="['card', $style.walletBar]">
	            <div>
	              <div :class="$style.walletBarLabel">支払いウォレット</div>
	              <div :class="$style.walletBarValue">{{ walletAddress }} / chain {{ walletChainId ?? '-' }}</div>
		              <div :class="$style.walletBarHint">別のアカウントで支払う場合は、ウォレット側でアカウントを切り替えてください。</div>
		            </div>
		          </div>
		          <div :class="['card', $style.tokenFilter]">
		            <div :class="$style.tokenSelectRow">
		              <label :class="$style.tokenSelectField">
		                <span :class="$style.tokenFilterTitle">通貨</span>
		                <select class="form-input" :value="selectedAssetId ?? ''" @change="selectPaymentAsset(($event.target as HTMLSelectElement).value)">
		                  <option v-for="asset in paymentAssetOptions" :key="asset.id" :value="asset.id">{{ asset.symbol }}</option>
		                </select>
		              </label>
		              <label :class="$style.tokenSelectField">
		                <span :class="$style.tokenFilterTitle">支払いトークン</span>
		                <select v-model="selectedFilterDeploymentId" class="form-input">
		                  <option v-for="token in filterPaymentTokenOptions" :key="token.deploymentId" :value="token.deploymentId">
		                    {{ token.symbol }} / {{ token.chainName ?? '-' }}
		                  </option>
		                </select>
		              </label>
		            </div>
		            <div v-if="selectedFilterPaymentToken" :class="$style.tokenAddress">
		              <div>
		                <span :class="$style.tokenAddressLabel">Token address</span>
		                <code>{{ selectedFilterPaymentToken.contractAddress }}</code>
		                <div :class="$style.tokenStatusLine">RPC: {{ selectedFilterTokenOffer?.isRpcConfigured ? '設定済み' : '未設定' }}</div>
		                <div :class="$style.tokenStatusLine">
		                  支払い元:
		                  <span v-if="!walletAddress">ウォレット未接続</span>
		                  <span v-else-if="selectedFilterTokenOffer && connectedWalletForOffer(selectedFilterTokenOffer)">連携済み</span>
		                  <span v-else>このチェーンでは未連携</span>
		                </div>
		              </div>
		              <button class="btn btn-secondary" type="button" :disabled="!canRegisterFilterToken()" @click="addFilterTokenToWallet">
		                {{ filterRegisterButtonLabel() }}
		              </button>
		            </div>
		          </div>
			          <div v-if="purchasePlans.length === 0" class="text-muted">購入可能なプランはありません。</div>
		          <div v-else :class="$style.offerGrid">
		            <article v-for="planGroup in purchasePlans" :key="planGroup.id" class="card" :class="$style.offer">
		              <div :class="$style.offerHeader">
		                <div :class="$style.offerTitle">{{ planGroup.plan.name }}</div>
		                <span v-if="currentPlanBadgeVisible(planGroup.plan)" class="badge badge-info">現在のプラン</span>
		              </div>
		              <dl :class="$style.quotaList">
		                <div v-for="quota in planQuotaItems(planGroup.plan)" :key="quota.label" :class="$style.quotaItem">
		                  <dt>{{ quota.label }}</dt>
		                  <dd>{{ quota.value }}</dd>
		                </div>
		              </dl>
		              <div :class="$style.capabilityLine">
		                <span :class="planGroup.plan.canUseDownloadCount ? $style.checkMark : $style.crossMark">
		                  {{ planGroup.plan.canUseDownloadCount ? '✔' : '×' }}
		                </span>
		                ダウンロード数表示 {{ planGroup.plan.canUseDownloadCount ? 'できる' : 'できない' }}
		              </div>
		              <div :class="$style.priceRows">
		                <div v-for="price in planGroup.prices" :key="priceRowKey(price)" :class="$style.priceRow">
		                  <span :class="$style.priceDuration">{{ formatDuration(selectedFilterOfferForPrice(price).durationDays, selectedFilterOfferForPrice(price).durationUnit) }}</span>
		                  <span :class="$style.priceValue">
		                    {{ formatOfferAmountValue(selectedFilterOfferForPrice(price)) }}
		                    <span :class="$style.priceCurrency">{{ selectedFilterOfferForPrice(price).tokenSymbol ?? selectedFilterOfferForPrice(price).assetSymbol }}</span>
		                  </span>
		                  <button class="btn btn-primary btn-sm" type="button" :disabled="priceButtonDisabled(price)" @click="openPriceDialog(price)">
		                    購入
		                  </button>
		                </div>
		              </div>
		            </article>
		          </div>
		          <Dialog.Root :model-value="purchaseDialogOpen" @update:model-value="onPurchaseDialogOpenChange">
		            <Dialog.Content :class="$style.dialog">
		              <div v-if="selectedPurchasePrice && selectedDialogOffer" :class="$style.dialogInner">
		                <div :class="$style.dialogHeader">
		                  <Dialog.Title :class="$style.dialogTitle">{{ dialogTitle() }}</Dialog.Title>
		                  <button class="btn btn-ghost btn-sm" type="button" @click="closePurchaseDialog">閉じる</button>
		                </div>
		                <div v-if="selectedPaymentToken" :class="$style.tokenAddress">
		                  <div>
		                    <span :class="$style.tokenAddressLabel">Token address</span>
		                    <code>{{ selectedPaymentToken.contractAddress }}</code>
		                    <div :class="$style.tokenStatusLine">RPC: {{ tokenStatusText() }}</div>
		                    <div :class="$style.tokenStatusLine">支払い元: {{ payerStatusText() }}</div>
		                  </div>
		                  <button class="btn btn-secondary" type="button" :disabled="!canRegisterSelectedToken()" @click="addSelectedTokenToWallet">
		                    {{ dialogRegisterButtonLabel() }}
		                  </button>
		                </div>
		                <div :class="$style.dialogSummary">
		                  <div>延長前期限: {{ formatDateOrDash(dialogExpiryBefore()) }}</div>
		                  <div>購入後期限: {{ formatDateOrDash(dialogExpiryAfter()) }}</div>
		                </div>
		                <dl :class="$style.dialogPaymentSummary">
		                  <div>
		                    <dt>割引計算式</dt>
		                    <dd>{{ dialogDiscountFormula() }}</dd>
		                  </div>
		                  <div>
		                    <dt>割引後価格</dt>
		                    <dd>{{ dialogPayableAmount() }}</dd>
		                  </div>
		                  <div>
		                    <dt>トークン</dt>
		                    <dd>{{ dialogTokenName() }}</dd>
		                  </div>
		                  <div>
		                    <dt>チェーン</dt>
		                    <dd>{{ dialogChainName() }}</dd>
		                  </div>
		                </dl>
		                <button class="btn btn-primary" type="button" :disabled="!canBuySelectedOffer()" @click="buySelectedOffer">
		                  {{ dialogPurchaseButtonLabel() }}
		                </button>
		              </div>
		            </Dialog.Content>
		          </Dialog.Root>
		        </div>
	      </template>
      <div v-if="cryptoPaymentsEnabled && !hasLinkedWallets && !walletSetupMode" class="text-muted mt-3">ウォレットタブで支払いウォレットを連携してください。</div>
    </template>
  </div>
</template>

<style module lang="scss">
.purchaseStack {
  display: grid;
  gap: 12px;
}

.purchaseStack > :global(.card) + :global(.card),
.offerGrid > :global(.card) + :global(.card) {
  margin-top: 0;
}

.offerGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
  gap: 12px;
}

.walletBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  max-width: none;
}

.tokenFilterTitle {
  display: block;
  margin-bottom: 6px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.tokenSelectRow {
  display: grid;
  grid-template-columns: repeat(2, minmax(180px, 1fr));
  gap: 12px;
}

.tokenSelectField {
  min-width: 0;
}

.tokenAddress {
  display: grid;
  gap: 8px;
  align-items: end;
  grid-template-columns: minmax(0, 1fr) auto;
  margin-top: 12px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.tokenAddress code {
  overflow-wrap: anywhere;
}

.tokenStatusLine {
  margin-top: 6px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.tokenAddressLabel {
  display: block;
  margin-bottom: 4px;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.walletBarLabel {
  margin-bottom: 4px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.walletBarValue {
  overflow-wrap: anywhere;
  font-family: var(--font-monospace);
  font-size: 0.875rem;
}

.walletBarHint {
  margin-top: 6px;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.offer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: none;
}

.offerTitle {
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.3;
}

.offerHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.quotaList {
  display: grid;
  gap: 6px;
  margin: 0;
}

.quotaItem {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.quotaItem dd {
  margin: 0;
  color: var(--color-text);
  font-weight: 600;
}

.capabilityLine {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.checkMark {
  color: var(--color-success);
  font-weight: 700;
}

.crossMark {
  color: var(--color-danger);
  font-weight: 700;
}

.priceRows {
  display: grid;
  gap: 8px;
  margin-top: auto;
  padding-top: 8px;
}

.priceRow {
  display: grid;
  grid-template-columns: minmax(72px, 1fr) minmax(72px, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.priceDuration,
.priceValue {
  font-size: 1.125rem;
  font-weight: 700;
}

.priceCurrency {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  font-weight: 600;
}

.dialog {
  color: var(--color-text);
  width: min(560px, calc(100vw - 32px));
  border: none;
  border-radius: var(--radius-lg);
  background: var(--color-bg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  max-height: 90vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.dialogInner {
  display: grid;
  gap: 16px;
  padding: 20px;
}

.dialogHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dialogTitle {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
}

.dialogSummary {
  display: grid;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.dialogPaymentSummary {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
}

.dialogPaymentSummary > div {
  display: grid;
  grid-template-columns: minmax(96px, 0.4fr) minmax(0, 1fr);
  gap: 12px;
  align-items: baseline;
}

.dialogPaymentSummary dt {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.dialogPaymentSummary dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-text);
  font-weight: 600;
}

@media (max-width: 640px) {
  .walletBar {
    align-items: stretch;
    flex-direction: column;
  }

  .tokenSelectRow {
    grid-template-columns: 1fr;
  }

  .tokenAddress {
    grid-template-columns: 1fr;
  }

  .dialogPaymentSummary > div {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
