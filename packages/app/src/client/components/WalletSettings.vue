<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiPost, type ApiSuccess } from '@/utils/api';
import { useWallet } from '@/composables/useWallet';

type LinkedWallet = ApiSuccess<'/api/account/wallets/list'>['data'][number];
type WalletLinkChain = ApiSuccess<'/api/account/wallets/link/chains'>['data'][number];
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

const wallets = ref<LinkedWallet[]>([]);
const walletLinkChains = ref<WalletLinkChain[]>([]);
const selectedWalletLinkChainId = ref<number | null>(null);
const walletLoading = ref(false);
const unlinkingWalletId = ref<string | null>(null);
const error = ref('');
const success = ref('');
const { walletAddress, walletChainId, connectWallet, switchOrAddWalletChain, signWalletMessage } = useWallet();
const emit = defineEmits<{
	changed: [];
	ready: [];
}>();

const selectedWalletLinkChain = computed(() => walletLinkChains.value.find(chain => chain.chainId === selectedWalletLinkChainId.value) ?? walletLinkChains.value[0] ?? null);
const connectedLinkedWallet = computed(() => {
	const address = walletAddress.value;
	if (!address || walletChainId.value == null) return null;
	return wallets.value.find(wallet => wallet.chainId === walletChainId.value && wallet.address.toLowerCase() === address.toLowerCase()) ?? null;
});
const canLinkWallet = computed(() => walletLoading.value === false && selectedWalletLinkChain.value != null && connectedLinkedWallet.value == null);

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

async function getWalletChainConfig(linkChain: WalletLinkChain) {
	const chainCatalog = await import('viem/chains') as Record<string, unknown>;
	const catalogChain = Object.values(chainCatalog)
		.find((value): value is ChainCatalogEntry => isChainCatalogEntry(value) && value.id === linkChain.chainId);
	if (!catalogChain) throw new Error(`chain ${linkChain.chainId} は viem/chains に見つかりません`);

	return {
		chainId: linkChain.chainId,
		name: linkChain.name,
		nativeCurrencyName: linkChain.nativeCurrencyName,
		nativeCurrencySymbol: linkChain.nativeCurrencySymbol,
		nativeCurrencyDecimals: linkChain.nativeCurrencyDecimals,
		rpcUrls: catalogChain.rpcUrls.default.http,
		blockExplorerUrl: linkChain.blockExplorerUrl ?? catalogChain.blockExplorers?.default.url ?? null,
	};
}

async function loadWallets(): Promise<void> {
	const [walletsResult, chainsResult] = await Promise.all([
		apiPost('/api/account/wallets/list'),
		apiPost('/api/account/wallets/link/chains'),
	]);
	if (walletsResult.ok) wallets.value = walletsResult.data;
	if (chainsResult.ok) {
		walletLinkChains.value = chainsResult.data;
		if (selectedWalletLinkChainId.value == null && chainsResult.data[0]) selectedWalletLinkChainId.value = chainsResult.data[0].chainId;
	}
}

async function linkWallet(): Promise<void> {
	error.value = '';
	success.value = '';
	walletLoading.value = true;
	try {
		if (connectedLinkedWallet.value) throw new Error('現在接続中のウォレットはすでに連携済みです。別のウォレットを追加するには、ウォレット側でアカウントを切り替えてください。');
		const linkChain = selectedWalletLinkChain.value;
		if (!linkChain) throw new Error('ウォレット連携に対応しているチェーンがありません');
		const { address, chainId } = await connectWallet();
		if (linkChain.chainId !== chainId) {
			await switchOrAddWalletChain(await getWalletChainConfig(linkChain));
		}
		const existingWallet = wallets.value.find(wallet => wallet.chainId === linkChain.chainId && wallet.address.toLowerCase() === address.toLowerCase());
		if (existingWallet) {
			success.value = '支払いウォレットを接続しました';
			emit('ready');
			emit('changed');
			return;
		}
		const beginResult = await apiPost('/api/account/wallets/link/begin', { address, chainId: linkChain.chainId });
		if (!beginResult.ok) {
			error.value = beginResult.data.message || 'ウォレット連携の開始に失敗しました';
			return;
		}
		const signature = await signWalletMessage(beginResult.data.message);
		const verifyResult = await apiPost('/api/account/wallets/link/verify', {
			nonce: beginResult.data.nonce,
			message: beginResult.data.message,
			signature,
		});
		if (!verifyResult.ok) {
			error.value = verifyResult.data.message || 'ウォレット署名の検証に失敗しました';
			return;
		}
		success.value = 'ウォレットを連携しました';
		await loadWallets();
		emit('ready');
		emit('changed');
	} catch (e) {
		error.value = String(e);
	} finally {
		walletLoading.value = false;
	}
}

async function unlinkWallet(wallet: LinkedWallet): Promise<void> {
	error.value = '';
	success.value = '';
	unlinkingWalletId.value = wallet.id;
	try {
		const result = await apiPost('/api/account/wallets/unlink', { walletId: wallet.id });
		if (!result.ok) {
			error.value = result.data.message || 'ウォレット連携の解除に失敗しました';
			return;
		}
		success.value = 'ウォレット連携を解除しました';
		await loadWallets();
		emit('changed');
	} catch (e) {
		error.value = String(e);
	} finally {
		unlinkingWalletId.value = null;
	}
}

function isConnectedWallet(wallet: LinkedWallet): boolean {
	return walletChainId.value === wallet.chainId && walletAddress.value?.toLowerCase() === wallet.address.toLowerCase();
}

onMounted(loadWallets);
</script>

<template>
  <div :class="['card', $style.card]">
    <div :class="$style.serviceHeader">
      <div>
        <h3 :class="$style.serviceTitle">Wallet</h3>
        <p :class="$style.serviceDescription">暗号資産決済で使用するウォレットをSIWE署名で連携します。</p>
      </div>
      <span :class="['badge', wallets.length > 0 ? 'badge-success' : 'badge-info']">
        {{ wallets.length > 0 ? `${wallets.length}件連携済み` : '未連携' }}
      </span>
    </div>
    <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>
    <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
    <div :class="$style.formGroup">
      <label class="form-label" for="wallet-link-chain">連携するチェーン</label>
      <select id="wallet-link-chain" v-model.number="selectedWalletLinkChainId" class="form-input" :disabled="walletLoading || walletLinkChains.length === 0">
        <option v-for="chain in walletLinkChains" :key="chain.chainId" :value="chain.chainId">{{ chain.name }} ({{ chain.chainId }})</option>
      </select>
    </div>
    <button class="btn btn-primary" type="button" :disabled="!canLinkWallet" @click="linkWallet">
      {{ walletLoading ? '処理中...' : 'ウォレットを連携' }}
    </button>
    <div v-if="connectedLinkedWallet" :class="$style.walletNotice">
      現在接続中のウォレットは連携済みです。別のウォレットを追加するには、ウォレット側でアカウントを切り替えてください。
    </div>
    <div v-if="wallets.length > 0" :class="$style.linkedList">
      <div v-for="wallet in wallets" :key="wallet.id" :class="$style.linkedItem">
        <div :class="$style.linkedContent">
          <div :class="$style.linkedName">
            <span :class="$style.addressText" :title="wallet.address">{{ wallet.address }}</span>
            <span v-if="isConnectedWallet(wallet)" class="badge badge-success">接続中</span>
          </div>
          <div :class="$style.linkedLink">chain {{ wallet.chainId }}</div>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" :disabled="unlinkingWalletId === wallet.id" @click="unlinkWallet(wallet)">
          {{ unlinkingWalletId === wallet.id ? '解除中...' : '解除' }}
        </button>
      </div>
    </div>
    <div v-else :class="$style.emptyLinked">連携済みウォレットはありません。</div>
  </div>
</template>

<style module lang="scss">
.card {
  max-width: 720px;
  margin-bottom: 16px;
}

.serviceHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.serviceTitle {
  margin: 0 0 6px;
  font-size: 1rem;
}

.serviceDescription {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.formGroup {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}

.linkedList {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

.linkedItem {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
}

.linkedContent {
  min-width: 0;
  flex: 1;
}

.linkedName {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  min-width: 0;
}

.addressText {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.linkedLink {
  display: block;
  margin-top: 2px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
  text-decoration: none;
}

.walletNotice,
.emptyLinked {
  margin-top: 12px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

@media (max-width: 600px) {
  .linkedItem {
    flex-direction: column;
  }
}
</style>
