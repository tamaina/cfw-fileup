<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { apiPost, type ApiSuccess } from '@/utils/api';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import SensitiveActionAuth from '@/components/SensitiveActionAuth.vue';
import { useWallet } from '@/composables/useWallet';
import { getChainMetadata } from '@/utils/chain-metadata';
import { useWalletRuntimeReload } from '@/components/WalletRuntimeProvider';
import { authStore } from '@/store/auth';

type LinkedWallet = ApiSuccess<'/api/account/wallets/list'>['data'][number];
type WalletLinkChain = ApiSuccess<'/api/account/wallets/link/chains'>['data'][number];
type ConnectedWalletConnection = ReturnType<typeof useWallet>['connectedWalletConnections']['value'][number];
type WalletConnectorOption = ReturnType<typeof useWallet>['walletConnectors']['value'][number];

const wallets = ref<LinkedWallet[]>([]);
const walletLinkChains = ref<WalletLinkChain[]>([]);
const selectedWalletLinkChainId = ref<number | null>(null);
const selectedWalletConnectorUid = ref<string | null>(null);
const walletLoading = ref(false);
const unlinkingWalletId = ref<string | null>(null);
const unlinkDialogOpen = ref(false);
const unlinkTargetWallet = ref<LinkedWallet | null>(null);
const walletRequestDialogOpen = ref(false);
const walletRequestStep = ref(1);
const walletRequestTotal = ref(1);
const walletRequestTitle = ref('');
const walletRequestDescription = ref('');
const walletRequestCancelRequested = ref(false);
const disconnectingConnectorUid = ref<string | null>(null);
const currentPassword = ref('');
const linkTurnstileToken = ref<string | null>(null);
const turnstileEnabled = ref(false);
const turnstileSiteKey = ref('');
const error = ref('');
const success = ref('');
const { walletAddress, walletChainId, activeWalletConnectorUid, connectedWalletConnections, walletConnectors, connectWallet, disconnectWalletConnection, clearWalletConnectStorage, switchWalletConnection, switchOrAddWalletChain, signWalletMessage } = useWallet();
const reloadWalletRuntime = useWalletRuntimeReload();
defineProps<{
	showBack?: boolean;
}>();
const emit = defineEmits<{
	back: [];
	changed: [];
	ready: [];
}>();

const selectedWalletLinkChain = computed(() => walletLinkChains.value.find(chain => chain.chainId === selectedWalletLinkChainId.value) ?? walletLinkChains.value[0] ?? null);
const recentlyAuthenticated = computed(() => authStore.user?.recentlyAuthenticated ?? false);
const passwordLinkReady = computed(() =>
	(authStore.user?.hasPassword ?? true)
	&& currentPassword.value.length > 0
	&& (!turnstileEnabled.value || linkTurnstileToken.value !== null),
);
const canStartLink = computed(() => recentlyAuthenticated.value || passwordLinkReady.value);
const selectedWalletConnector = computed(() => walletConnectors.value.find(connector => connector.uid === selectedWalletConnectorUid.value) ?? walletConnectors.value[0] ?? null);
const isSelectedWalletConnectorActive = computed(() => selectedWalletConnector.value != null && activeWalletConnectorUid.value === selectedWalletConnector.value.uid);
const connectedLinkedWallet = computed(() => {
	if (!isSelectedWalletConnectorActive.value) return null;
	const address = walletAddress.value;
	if (!address || walletChainId.value == null) return null;
	return wallets.value.find(wallet => wallet.chainId === walletChainId.value && wallet.address.toLowerCase() === address.toLowerCase()) ?? null;
});
const selectedWalletConnectorConnection = computed(() => selectedWalletConnector.value
	? connectedWalletConnections.value.find(connection => connection.connectorUid === selectedWalletConnector.value?.uid) ?? null
	: null);
const selectedWalletConnection = computed(() => {
	const connectorUid = activeWalletConnectorUid.value;
	if (!connectorUid) return null;
	return connectedWalletConnections.value.find(connection => connection.connectorUid === connectorUid) ?? null;
});
const unlinkDialogMessage = computed(() => {
	const wallet = unlinkTargetWallet.value;
	if (!wallet) return '';
	return `${wallet.address} の支払いウォレット連携を解除します。接続中の場合はウォレット接続も解除します。必要になったら、いつでももう一度連携できます。`;
});
const sortedWallets = computed(() => wallets.value
	.map((wallet, index) => ({ wallet, index }))
	.sort((a, b) => {
		const selectedDiff = Number(isSelectedWallet(b.wallet)) - Number(isSelectedWallet(a.wallet));
		if (selectedDiff !== 0) return selectedDiff;
		const connectedDiff = Number(isConnectedWallet(a.wallet) === false) - Number(isConnectedWallet(b.wallet) === false);
		if (connectedDiff !== 0) return connectedDiff;
		return a.index - b.index;
	})
	.map(item => item.wallet));
const walletConnectConnectorOptions = computed(() => walletConnectors.value.filter(connector => connector.id === 'walletConnect' || connector.type === 'walletConnect'));
const disconnectableWalletConnectors = computed(() => {
	const optionsByUid = new Map(walletConnectors.value.map(connector => [connector.uid, connector]));
	const connectedOptions = connectedWalletConnections.value.flatMap(connection => {
		const option = optionsByUid.get(connection.connectorUid);
		return option ? [option] : [];
	});
	const options = [...connectedOptions, ...walletConnectConnectorOptions.value];
	return Array.from(new Map(options.map(option => [option.uid, option])).values());
});

function showWalletRequestProgress(step: number, total: number, title: string, description: string): void {
	if (walletRequestCancelRequested.value) return;
	walletRequestStep.value = step;
	walletRequestTotal.value = Math.max(step, total);
	walletRequestTitle.value = title;
	walletRequestDescription.value = description;
	walletRequestDialogOpen.value = true;
}

function closeWalletRequestProgress(): void {
	walletRequestDialogOpen.value = false;
	walletRequestStep.value = 1;
	walletRequestTotal.value = 1;
	walletRequestTitle.value = '';
	walletRequestDescription.value = '';
}

function cancelWalletRequestProgress(): void {
	walletRequestCancelRequested.value = true;
	walletRequestDialogOpen.value = false;
	walletLoading.value = false;
	error.value = 'ウォレット連携を中止しました。ウォレットアプリに残っている要求は拒否してください。';
}

function assertWalletRequestNotCancelled(): void {
	if (walletRequestCancelRequested.value) throw new Error('ウォレット連携を中止しました');
}

async function getWalletChainConfig(linkChain: WalletLinkChain) {
	const catalogChain = await getChainMetadata(linkChain.chainId);
	if (!catalogChain) throw new Error(`chain ${linkChain.chainId} は viem/chains に見つかりません`);

	return {
		chainId: linkChain.chainId,
		name: linkChain.name,
		nativeCurrencyName: linkChain.nativeCurrencyName,
		nativeCurrencySymbol: linkChain.nativeCurrencySymbol,
		nativeCurrencyDecimals: linkChain.nativeCurrencyDecimals,
		rpcUrls: [...catalogChain.rpcUrls.default.http],
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

async function loadMeta(): Promise<void> {
	try {
		const res = await fetch('/api/meta');
		if (!res.ok) return;
		const data = await res.json() as { turnstileEnabled?: boolean; turnstileSiteKey?: string };
		turnstileEnabled.value = data.turnstileEnabled ?? false;
		turnstileSiteKey.value = data.turnstileSiteKey ?? '';
	} catch {
		turnstileEnabled.value = false;
		turnstileSiteKey.value = '';
	}
}

async function linkWallet(): Promise<void> {
	error.value = '';
	success.value = '';
	walletLoading.value = true;
	walletRequestCancelRequested.value = false;
	let shouldReloadWalletRuntime = false;
	try {
		if (connectedLinkedWallet.value) throw new Error('選択中の接続方法で接続中のウォレットはすでに連携済みです。別のウォレットを追加するには、ウォレット側でアカウントを切り替えるか、別の接続方法を選んでください。');
		const linkChain = selectedWalletLinkChain.value;
		if (!linkChain) throw new Error('ウォレット連携に対応しているチェーンがありません');
		const connectorUid = selectedWalletConnector.value?.uid;
		const connectorName = selectedWalletConnector.value?.name ?? 'ウォレット';
		const connection = selectedWalletConnectorConnection.value;
		if (!connection) {
			showWalletRequestProgress(
				1,
				3,
				`${connectorName}の接続を承認`,
				'ウォレットアプリで接続を承認してください。このあとチェーン切替や署名の確認が続くことがあります。',
			);
		}
		const { address, chainId } = connection ?? await connectWallet(connectorUid);
		assertWalletRequestNotCancelled();
		if (linkChain.chainId !== chainId) {
			showWalletRequestProgress(
				connection ? 1 : 2,
				connection ? 2 : 3,
				'チェーン切替を承認',
				`${linkChain.name} に切り替えます。ウォレットアプリで承認してください。`,
			);
			await switchOrAddWalletChain(await getWalletChainConfig(linkChain), connectorUid);
			assertWalletRequestNotCancelled();
		}
		const existingWallet = wallets.value.find(wallet => wallet.chainId === linkChain.chainId && wallet.address.toLowerCase() === address.toLowerCase());
		if (existingWallet) {
			closeWalletRequestProgress();
			success.value = '支払いウォレットを接続しました';
			emit('ready');
			emit('changed');
			shouldReloadWalletRuntime = true;
			return;
		}
		if (!canStartLink.value) {
			error.value = 'ウォレットを連携するには、先に本人確認欄で再認証してください。';
			return;
		}
		const beginResult = await apiPost('/api/account/wallets/link/begin', {
			address,
			chainId: linkChain.chainId,
			currentPassword: currentPassword.value || undefined,
			turnstileToken: currentPassword.value ? linkTurnstileToken.value ?? undefined : undefined,
		});
		if (!beginResult.ok) {
			error.value = beginResult.data.message || 'ウォレット連携の開始に失敗しました';
			return;
		}
		const didSwitchChain = linkChain.chainId !== chainId;
		showWalletRequestProgress(
			connection
				? didSwitchChain ? 2 : 1
				: didSwitchChain ? 3 : 2,
			connection
				? didSwitchChain ? 2 : 1
				: didSwitchChain ? 3 : 2,
			'署名を承認',
			'支払いウォレットとして連携するため、ウォレットアプリでSIWE署名を承認してください。',
		);
		const signature = await signWalletMessage(beginResult.data.message, connectorUid, address);
		assertWalletRequestNotCancelled();
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
		shouldReloadWalletRuntime = true;
	} catch (e) {
		error.value = String(e);
	} finally {
		closeWalletRequestProgress();
		walletLoading.value = false;
		if (shouldReloadWalletRuntime) reloadWalletRuntime();
	}
}

async function unlinkWallet(wallet: LinkedWallet): Promise<void> {
	error.value = '';
	success.value = '';
	unlinkingWalletId.value = wallet.id;
	const connections = connectedConnectionsForWallet(wallet);
	let shouldReloadWalletRuntime = false;
	try {
		const result = await apiPost('/api/account/wallets/unlink', { walletId: wallet.id });
		if (!result.ok) {
			error.value = result.data.message || 'ウォレット連携の解除に失敗しました';
			return;
		}
		await Promise.all(connections.map(connection => disconnectWalletConnection(connection.connectorUid)));
		success.value = connections.length > 0
			? 'ウォレット連携を解除し、ウォレット接続も解除しました'
			: 'ウォレット連携を解除しました';
		await loadWallets();
		emit('changed');
		shouldReloadWalletRuntime = true;
	} catch (e) {
		error.value = String(e);
	} finally {
		unlinkingWalletId.value = null;
		if (shouldReloadWalletRuntime) reloadWalletRuntime();
	}
}

function openUnlinkDialog(wallet: LinkedWallet): void {
	unlinkTargetWallet.value = wallet;
	unlinkDialogOpen.value = true;
}

function closeUnlinkDialog(): void {
	unlinkDialogOpen.value = false;
	unlinkTargetWallet.value = null;
}

async function confirmUnlinkWallet(): Promise<void> {
	const wallet = unlinkTargetWallet.value;
	closeUnlinkDialog();
	if (!wallet) return;
	await unlinkWallet(wallet);
}

function linkedWalletForConnection(connection: ConnectedWalletConnection): LinkedWallet | null {
	return wallets.value.find(wallet => wallet.chainId === connection.chainId && wallet.address.toLowerCase() === connection.address.toLowerCase()) ?? null;
}

function connectedConnectionsForWallet(wallet: LinkedWallet): ConnectedWalletConnection[] {
	return connectedWalletConnections.value.filter(connection => connection.chainId === wallet.chainId && connection.address.toLowerCase() === wallet.address.toLowerCase());
}

function connectedConnectionForWalletConnector(wallet: LinkedWallet, connectorUid: string): ConnectedWalletConnection | null {
	return connectedConnectionsForWallet(wallet).find(connection => connection.connectorUid === connectorUid) ?? null;
}

function connectedConnectionForConnector(connectorUid: string): ConnectedWalletConnection | null {
	return connectedWalletConnections.value.find(connection => connection.connectorUid === connectorUid) ?? null;
}

function isConnectorConnectedToOtherWallet(wallet: LinkedWallet, connector: WalletConnectorOption): boolean {
	return connectedConnectionForWalletConnector(wallet, connector.uid) == null && connectedConnectionForConnector(connector.uid) != null;
}

function isConnectedWallet(wallet: LinkedWallet): boolean {
	return connectedConnectionsForWallet(wallet).length > 0;
}

function isSelectedWallet(wallet: LinkedWallet): boolean {
	return connectedConnectionsForWallet(wallet).some(isSelectedWalletConnection);
}

function isSelectedWalletConnection(connection: ConnectedWalletConnection): boolean {
	const selectedConnection = selectedWalletConnection.value;
	return selectedConnection != null
		&& connection.connectorUid === selectedConnection.connectorUid
		&& connection.address.toLowerCase() === selectedConnection.address.toLowerCase()
		&& connection.chainId === selectedConnection.chainId;
}

function walletConnectorButtonLabel(wallet: LinkedWallet, connector: WalletConnectorOption): string {
	const connection = connectedConnectionForWalletConnector(wallet, connector.uid);
	if (connection && isSelectedWalletConnection(connection)) return `${connector.name}で接続中`;
	if (connection) return `${connector.name}で選択`;
	return `${connector.name}未接続`;
}

function isWalletConnectorButtonDisabled(wallet: LinkedWallet, connector: WalletConnectorOption): boolean {
	const connection = connectedConnectionForWalletConnector(wallet, connector.uid);
	return walletLoading.value
		|| (connection != null && isSelectedWalletConnection(connection));
}

async function connectWithConnector(connectorUid: string): Promise<void> {
	selectedWalletConnectorUid.value = connectorUid;
	await linkWallet();
}

async function handleWalletConnector(wallet: LinkedWallet, connector: WalletConnectorOption): Promise<void> {
	const connection = connectedConnectionForWalletConnector(wallet, connector.uid);
	if (!connection) return;
	await selectWalletConnection(connection);
}

async function selectWalletConnection(connection: ConnectedWalletConnection): Promise<void> {
	if (!linkedWalletForConnection(connection)) return;
	error.value = '';
	success.value = '';
	walletLoading.value = true;
	let shouldReloadWalletRuntime = false;
	try {
		await switchWalletConnection(connection.connectorUid);
		success.value = '支払いウォレットを選択しました';
		emit('ready');
		emit('changed');
		shouldReloadWalletRuntime = true;
	} catch (e) {
		error.value = String(e);
	} finally {
		walletLoading.value = false;
		if (shouldReloadWalletRuntime) reloadWalletRuntime();
	}
}

async function disconnectWalletConnectorByUid(connectorUid: string): Promise<void> {
	error.value = '';
	success.value = '';
	disconnectingConnectorUid.value = connectorUid;
	try {
		await disconnectWalletConnection(connectorUid);
		await clearWalletConnectStorage();
		success.value = 'ウォレット接続を解除しました';
		emit('changed');
		reloadWalletRuntime();
	} catch (e) {
		error.value = String(e);
	} finally {
		disconnectingConnectorUid.value = null;
	}
}

onMounted(async () => {
	await Promise.all([loadWallets(), loadMeta()]);
});

watch(walletConnectors, connectors => {
	if (selectedWalletConnectorUid.value && connectors.some(connector => connector.uid === selectedWalletConnectorUid.value)) return;
	selectedWalletConnectorUid.value = connectors[0]?.uid ?? null;
}, { immediate: true });
</script>

<template>
  <div :class="['card', $style.card]">
    <div :class="$style.serviceHeader">
      <div>
        <h3 :class="$style.serviceTitle">Wallet</h3>
        <p :class="$style.serviceDescription">暗号資産決済で使用するウォレットをSIWE署名で連携します。</p>
      </div>
      <div :class="$style.headerActions">
        <button v-if="showBack" class="btn btn-secondary btn-sm" type="button" :disabled="walletLoading" @click="emit('back')">購入画面に戻る</button>
        <span :class="['badge', wallets.length > 0 ? 'badge-success' : 'badge-info']">
          {{ wallets.length > 0 ? `${wallets.length}件連携済み` : '未連携' }}
        </span>
      </div>
    </div>
    <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>
    <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
    <div v-if="connectedLinkedWallet" :class="$style.walletNotice">
      選択中の接続方法で接続中のウォレットは連携済みです。別のウォレットを追加するには、ウォレット側でアカウントを切り替えるか、別の接続方法を選んでください。
    </div>
    <div v-else-if="wallets.length > 0" :class="$style.walletNotice">
      接続先を変えたい場合は、ウォレットアプリ側で連携済みアドレスを選択してください。接続中の連携済みウォレットだけをここで選択できます。
    </div>
    <SensitiveActionAuth
      v-model:currentPassword="currentPassword"
      :class="$style.reauthPanel"
      description="ウォレット連携の前に、パスキーで本人確認します。パスワード設定済みの場合だけ、現在のパスワードでも続行できます。"
      password-input-id="wallet-link-current-password"
      password-hint="パスキーで再認証した場合、この入力は不要です。"
      :turnstile-enabled="turnstileEnabled"
      :turnstile-site-key="turnstileSiteKey"
      v-model:turnstile-token="linkTurnstileToken"
      @success="(message: string) => { error = ''; success = message; }"
      @error="(message: string) => { success = ''; error = message; }"
    />
    <div v-if="wallets.length > 0" :class="$style.linkedList">
      <div v-for="wallet in sortedWallets" :key="wallet.id" :class="[$style.linkedItem, isSelectedWallet(wallet) ? $style.linkedItemActive : '']">
        <div :class="$style.walletInfo">
          <div :class="$style.linkedContent">
            <div :class="$style.linkedName">
              <span :class="$style.addressText" :title="wallet.address">{{ wallet.address }}</span>
            </div>
            <div :class="$style.walletMeta">
              <span>chain {{ wallet.chainId }}</span>
              <span class="badge badge-success">連携済み</span>
              <span v-if="isConnectedWallet(wallet)" class="badge badge-info">接続中</span>
              <span v-if="isSelectedWallet(wallet)" class="badge badge-success">選択中</span>
            </div>
          </div>
        </div>
        <div :class="$style.walletTopActions">
          <button class="btn btn-secondary btn-sm" type="button" :disabled="unlinkingWalletId === wallet.id" @click="openUnlinkDialog(wallet)">
            {{ unlinkingWalletId === wallet.id ? '解除中...' : '連携解除' }}
          </button>
        </div>
        <div :class="$style.walletActions">
          <template v-for="connector in walletConnectors" :key="connector.uid">
            <button
              v-if="connectedConnectionForWalletConnector(wallet, connector.uid)"
              class="btn btn-primary btn-sm"
              type="button"
              :disabled="isWalletConnectorButtonDisabled(wallet, connector)"
              @click="handleWalletConnector(wallet, connector)"
            >
              {{ walletConnectorButtonLabel(wallet, connector) }}
            </button>
          </template>
        </div>
      </div>
    </div>
    <div v-if="wallets.length === 0" :class="$style.emptyLinked">連携済みウォレットはありません。</div>
    <section :class="$style.linkSection">
      <h4 :class="$style.connectorTitle">新しいウォレットを連携</h4>
      <div v-if="!canStartLink" class="alert alert-info mb-3">
        ウォレットを連携するには、本人確認欄でパスキーかパスワードで再認証してください。
      </div>
      <div :class="$style.formGroup">
        <label class="form-label" for="wallet-link-chain">連携するチェーン</label>
        <select id="wallet-link-chain" v-model.number="selectedWalletLinkChainId" class="form-input" :disabled="walletLoading || walletLinkChains.length === 0">
          <option v-for="chain in walletLinkChains" :key="chain.chainId" :value="chain.chainId">{{ chain.name }} ({{ chain.chainId }})</option>
        </select>
      </div>
      <div :class="$style.linkActions">
        <button
          v-for="connector in walletConnectors"
          :key="connector.uid"
          class="btn btn-primary btn-sm"
          type="button"
          :disabled="walletLoading || selectedWalletLinkChain == null || !canStartLink"
          @click="connectWithConnector(connector.uid)"
        >
          <span v-if="walletLoading && selectedWalletConnectorUid === connector.uid" class="btn-spinner" aria-hidden="true" />
          {{ walletLoading && selectedWalletConnectorUid === connector.uid ? '処理中...' : `${connector.name}で連携` }}
        </button>
      </div>
    </section>
    <div v-if="disconnectableWalletConnectors.length > 0" :class="$style.disconnectActions">
      <button
        v-for="connector in disconnectableWalletConnectors"
        :key="connector.uid"
        class="btn btn-secondary btn-sm"
        type="button"
        :disabled="walletLoading || disconnectingConnectorUid === connector.uid"
        @click="disconnectWalletConnectorByUid(connector.uid)"
      >
        {{ disconnectingConnectorUid === connector.uid ? '解除中...' : `${connector.name}解除` }}
      </button>
    </div>
    <ConfirmDialog
      v-model:open="unlinkDialogOpen"
      title="ウォレット連携を解除"
      :message="unlinkDialogMessage"
      confirm-label="連携解除"
      cancel-label="キャンセル"
      @confirm="confirmUnlinkWallet"
      @cancel="closeUnlinkDialog"
    />
    <div v-if="walletRequestDialogOpen" :class="$style.requestOverlay">
      <div :class="$style.requestPanel" role="status" aria-live="polite">
        <div :class="$style.requestInner">
          <div :class="$style.requestHeader">
            <span class="spinner" />
            <div>
              <h4 :class="$style.requestTitle">{{ walletRequestTitle }}</h4>
              <p :class="$style.requestCount">ウォレット承認 {{ walletRequestStep }} / {{ walletRequestTotal }}</p>
            </div>
          </div>
          <p :class="$style.requestDescription">{{ walletRequestDescription }}</p>
          <div :class="$style.requestActions">
            <button class="btn btn-secondary" type="button" @click="cancelWalletRequestProgress">やめる</button>
          </div>
        </div>
      </div>
    </div>
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

.headerActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
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

.reauthPanel {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}

.linkedList {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

.connectorTitle {
  margin: 0 0 4px;
  font-size: 0.95rem;
}

.linkedItem {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    "info topActions"
    "info topActions"
    "info actions";
  gap: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 16px;
}

.linkedItemActive {
  border-color: var(--color-primary);
}

.walletInfo {
  grid-area: info;
  min-width: 0;
}

.walletTopActions {
  grid-area: topActions;
  display: flex;
  justify-content: flex-end;
  align-self: start;
}

.walletActions {
  grid-area: actions;
  align-self: end;
}

.linkedContent {
  min-width: 0;
  flex: 1;
}

.linkedName {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
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

.walletMeta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.linkedLink {
  display: block;
  margin-top: 2px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
  text-decoration: none;
}

.walletActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.linkActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.disconnectActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.connectorStatus {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.linkSection {
  display: grid;
  gap: 8px;
  margin-top: 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
}

.requestOverlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(2px);
}

.requestPanel {
  width: min(440px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;
  border-radius: var(--radius-lg);
  color: var(--color-text);
  background: var(--color-bg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
}

.requestInner {
  display: grid;
  gap: 14px;
  padding: 24px;
}

.requestHeader {
  display: flex;
  align-items: center;
  gap: 12px;
}

.requestTitle {
  margin: 0;
  font-size: 1rem;
}

.requestCount,
.requestDescription {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.requestActions {
  display: flex;
  justify-content: flex-end;
}

.walletNotice,
.emptyLinked {
  margin: 12px 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

@media (max-width: 600px) {
  .linkedItem {
    grid-template-columns: 1fr;
    grid-template-areas:
      "info"
      "topActions"
      "actions";
  }

  .walletTopActions,
  .linkActions,
  .disconnectActions {
    justify-content: flex-start;
  }

  .walletActions {
    justify-content: flex-start;
  }
}
</style>
