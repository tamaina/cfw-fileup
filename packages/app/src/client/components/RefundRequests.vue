<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { encodeFunctionData, erc20Abi, formatUnits } from 'viem';
import { apiPost } from '@/utils/api';
import { useWallet } from '@/composables/useWallet';
import { getChainMetadata } from '@/utils/chain-metadata';
import type { RefundQuote, RefundView } from '../../shared/api/refunds';

const props = defineProps<{ admin?: boolean }>();
const views = ref<RefundView[]>([]);
const cursor = ref<string | null>(null);
const error = ref('');
const busy = ref(false);
const immediate = ref(true);
const requestedDate = ref('');
const selected = ref<RefundView | null>(null);
const effectiveDate = ref('');
const reason = ref('');
const quote = ref<RefundQuote | null>(null);
const hashes = ref<Record<string, string>>({});
const { walletAddress, connectWallet, switchOrAddWalletChain, sendWalletTransaction } = useWallet();
let createAttempt: { key: string; cutoff: number | null } | null = null;

const labels: Record<string, string> = {
	requested: '申請受付', review_required: '管理者確認が必要', prepared: '承認済み・送金準備', processing: '送金確認中',
	completed: '返金完了', rejected: '却下', cancelled: '取消済み', broadcast_pending: '送信結果・Tx Hashを確認してください', submitted: 'チェーン確認待ち', verified: '送金確認済み',
};
function date(ms: number | null) { return ms === null ? '未決定' : new Date(ms).toLocaleString(); }
function localInput(ms: number) { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
function canClose(view: RefundView) { return ['requested', 'review_required', 'prepared'].includes(view.request.status); }

async function load() {
	const result = props.admin ? await apiPost('/api/admin/list-refund-requests', { cursor: cursor.value }) : await apiPost('/api/billing/list-my-refund-requests', { cursor: cursor.value });
	if (!result.ok) throw new Error(result.data.message);
	views.value = result.data;
	if (selected.value) {
		const result = props.admin ? await apiPost('/api/admin/show-refund-request', { requestId: selected.value.request.id }) : await apiPost('/api/billing/show-refund-request', { requestId: selected.value.request.id });
		if (result.ok) selected.value = result.data;
	}
}
async function run(action: () => Promise<void>) {
	busy.value = true; error.value = '';
	try { await action(); await load(); } catch (e) { error.value = String(e); } finally { busy.value = false; }
}
async function createRequest() {
	await run(async () => {
		const cutoff = immediate.value ? null : new Date(requestedDate.value).getTime();
		if (cutoff !== null && !Number.isFinite(cutoff)) throw new Error('終了希望日時を入力してください。');
		createAttempt ??= { key: crypto.randomUUID(), cutoff };
		const result = await apiPost('/api/billing/create-refund-request', { idempotencyKey: createAttempt.key, requestedCutoffAt: createAttempt.cutoff });
		if (!result.ok) {
			// A definite validation/conflict rejection can be corrected. Preserve
			// the attempt only when delivery/commit has an uncertain outcome.
			if (result.status < 500) createAttempt = null;
			throw new Error(result.data.message);
		}
		createAttempt = null;
	});
}
function select(view: RefundView) {
	selected.value = view; effectiveDate.value = localInput(view.request.effectiveCutoffAt ?? view.request.requestedCutoffAt);
	reason.value = view.request.adjustmentReason; quote.value = view.request.quote;
	for (const transfer of view.transfers) hashes.value[transfer.id] = transfer.txHash ?? localStorage.getItem(`refund-tx:${transfer.id}`) ?? '';
}
function effectiveCutoff(view: RefundView) {
	// Preserve exact milliseconds when the datetime input has not been edited.
	const original = view.request.effectiveCutoffAt ?? view.request.requestedCutoffAt;
	return effectiveDate.value === localInput(original) ? original : new Date(effectiveDate.value).getTime();
}
async function recalculate(view: RefundView) {
	await run(async () => {
		const result = await apiPost('/api/admin/quote-refund', { requestId: view.request.id, effectiveCutoffAt: effectiveCutoff(view) });
		if (!result.ok) throw new Error(result.data.message);
		quote.value = result.data;
	});
}
async function approve(view: RefundView) {
	await run(async () => {
		if (!quote.value || quote.value.effectiveCutoffAt !== effectiveCutoff(view)) throw new Error('終了日時を再計算して確認してください。');
		const result = await apiPost('/api/admin/prepare-refund', { requestId: view.request.id, version: view.request.version,
			effectiveCutoffAt: effectiveCutoff(view), adjustmentReason: reason.value, quoteRevision: quote.value.revision });
		if (!result.ok) throw new Error(result.data.message);
		select(result.data);
	});
}
async function close(view: RefundView) {
	await run(async () => {
		const result = props.admin
			? await apiPost('/api/admin/reject-refund', { requestId: view.request.id, version: view.request.version, reason: reason.value })
			: await apiPost('/api/billing/cancel-refund-request', { requestId: view.request.id, version: view.request.version });
		if (!result.ok) throw new Error(result.data.message);
	});
}
async function send(view: RefundView, transferId: string) {
	await run(async () => {
		const group = view.request.quote?.groups.find(item => item.id === transferId);
		if (!group) throw new Error('返金明細がありません。');
		const from = walletAddress.value ?? (await connectWallet()).address;
		const chain = await getChainMetadata(group.chainId);
		if (!chain) throw new Error('チェーン情報を確認できません。送金は開始していません。');
		await switchOrAddWalletChain({ chainId: group.chainId, name: chain.name,
			nativeCurrencyName: chain.nativeCurrency.name, nativeCurrencySymbol: chain.nativeCurrency.symbol,
			nativeCurrencyDecimals: chain.nativeCurrency.decimals, rpcUrls: [...chain.rpcUrls.default.http],
			blockExplorerUrl: chain.blockExplorers?.default.url ?? null });
		const started = await apiPost('/api/admin/start-refund-transfer', { requestId: view.request.id, version: view.request.version, transferId, senderAddress: from });
		if (!started.ok) throw new Error(started.data.message);
		selected.value = started.data;
		// Server records broadcast intent first. A rejected/uncertain wallet result
		// never leads to automatic retry or release of the refund reservation.
		const hash = await sendWalletTransaction({ account: from as `0x${string}`, chainId: group.chainId,
			to: group.contractAddress as `0x${string}`, value: 0n,
			data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [group.payerAddress as `0x${string}`, BigInt(group.amountBaseUnits)] }) });
		hashes.value[transferId] = hash;
		localStorage.setItem(`refund-tx:${transferId}`, hash);
		await submitHash(started.data, transferId);
	});
}
async function submitHash(view: RefundView, transferId: string) {
	const result = await apiPost('/api/admin/submit-refund-transfer', { requestId: view.request.id, transferId, txHash: hashes.value[transferId] ?? '' });
	if (!result.ok) throw new Error(result.data.message);
	selected.value = result.data;
}
async function check(view: RefundView) {
	await run(async () => {
		const result = await apiPost('/api/admin/check-refund', { requestId: view.request.id });
		if (!result.ok) throw new Error(result.data.message);
		selected.value = result.data;
	});
}
async function document(view: RefundView) {
	await run(async () => {
		const { downloadRefundPdf } = await import('@/utils/refund-pdf');
		await downloadRefundPdf(view);
	});
}
onMounted(() => run(load));
</script>

<template>
  <section class="card p-4 refund-panel">
    <h3>{{ admin ? '返金申請の管理' : '返金申請' }}</h3>
    <p>申請ではプランは終了しません。原購入時のウォレットごとに返金し、全送金をサーバーが確認してから終了日時を反映します。</p>
    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <form v-if="!admin" @submit.prevent="createRequest">
      <label><input v-model="immediate" type="checkbox"> 今すぐを終了希望日時にする</label>
      <label v-if="!immediate">終了希望日時（端末のタイムゾーン）<input v-model="requestedDate" class="form-input" type="datetime-local" required></label>
      <button class="btn btn-primary" :disabled="busy" type="submit">返金を申請</button>
    </form>
    <button class="btn btn-secondary" :disabled="busy" @click="run(load)">履歴を更新</button>
    <button v-if="cursor" class="btn btn-secondary" :disabled="busy" @click="run(async () => { cursor = null; await load(); })">最新の履歴</button>
    <button v-if="views.length === 100" class="btn btn-secondary" :disabled="busy" @click="run(async () => { cursor = views[views.length - 1].request.id; await load(); })">過去の履歴</button>
    <p v-if="views.length === 0">返金申請はありません。</p>
    <article v-for="view in views" :key="view.request.id" class="card p-4 mt-4">
      <p>申請 {{ view.request.id }} <span v-if="admin"> / ユーザー {{ view.request.userId }}</span></p>
      <p>{{ labels[view.request.status] }} / 終了希望: {{ date(view.request.requestedCutoffAt) }} / 適用日時: {{ date(view.request.effectiveCutoffAt) }}</p>
      <p v-if="view.request.adjustmentReason">日時調整理由: {{ view.request.adjustmentReason }}</p>
      <p v-if="view.request.decisionReason">理由: {{ view.request.decisionReason }}</p>
      <p v-for="message in view.request.quote?.reviewReasons" :key="message" class="alert alert-info">{{ message }}</p>
      <button v-if="admin" class="btn btn-secondary" :disabled="busy" @click="select(view)">詳細・返金処理</button>
      <button v-if="!admin && canClose(view)" class="btn btn-secondary" :disabled="busy" @click="close(view)">申請を取消</button>
      <button v-if="view.request.status === 'completed'" class="btn btn-secondary" :disabled="busy" @click="document(view)">返金証憑 PDF</button>
      <p v-for="group in view.request.quote?.groups" :key="group.id">
        {{ formatUnits(BigInt(group.amountBaseUnits), group.decimals) }} {{ group.tokenSymbol }} / {{ group.chainName }} → {{ group.payerAddress }}
      </p>
    </article>
    <section v-if="admin && selected" class="card p-4 mt-4">
      <h4>申請 {{ selected.request.id }}</h4>
      <template v-if="['requested', 'review_required'].includes(selected.request.status)">
        <label>適用する終了日時（端末のタイムゾーン）<input v-model="effectiveDate" class="form-input" type="datetime-local"></label>
        <label>調整・却下理由<input v-model="reason" class="form-input" maxlength="1000"></label>
        <button class="btn btn-secondary" :disabled="busy" @click="recalculate(selected)">返金額を再計算</button>
        <p v-for="message in quote?.reviewReasons" :key="message" class="alert alert-info">{{ message }}</p>
        <p v-for="group in quote?.groups" :key="group.id">{{ formatUnits(BigInt(group.amountBaseUnits), group.decimals) }} {{ group.tokenSymbol }} / {{ group.chainName }} → {{ group.payerAddress }}</p>
        <button class="btn btn-primary" :disabled="busy || !quote || quote.reviewReasons.length > 0" @click="approve(selected)">見積を承認して送金準備</button>
      </template>
      <template v-if="['prepared', 'processing'].includes(selected.request.status)">
        <p>送信結果不明・ウォレット拒否の場合は再送せず、ウォレット履歴からTx Hashを確認してください。</p>
        <div v-for="transfer in selected.transfers" :key="transfer.id" class="card p-4">
          <p>{{ labels[transfer.status] }} / {{ selected.request.quote?.groups.find(g => g.id === transfer.id)?.payerAddress }}</p>
          <p v-for="group in selected.request.quote?.groups.filter(g => g.id === transfer.id)" :key="group.id">
            {{ formatUnits(BigInt(group.amountBaseUnits), group.decimals) }} {{ group.tokenSymbol }} / {{ group.chainName }}<br>
            トークン契約: {{ group.contractAddress }}
          </p>
          <p v-if="transfer.senderAddress">送金元: {{ transfer.senderAddress }}</p>
          <button v-if="transfer.status === 'prepared'" class="btn btn-primary" :disabled="busy" @click="send(selected, transfer.id)">接続ウォレットから送金</button>
          <template v-if="transfer.status === 'broadcast_pending'">
            <label>送信済み Tx Hash<input v-model="hashes[transfer.id]" class="form-input" placeholder="0x..."></label>
            <button class="btn btn-secondary" :disabled="busy" @click="run(() => submitHash(selected!, transfer.id))">Tx Hashを登録</button>
          </template>
          <p v-if="transfer.txHash">{{ transfer.txHash }}</p>
        </div>
        <button class="btn btn-secondary" :disabled="busy" @click="check(selected)">全送金をチェーン確認</button>
      </template>
      <template v-if="canClose(selected)">
        <label v-if="selected.request.status === 'prepared'">却下理由<input v-model="reason" class="form-input"></label>
        <button class="btn btn-secondary" :disabled="busy || reason.trim() === ''" @click="close(selected)">申請を却下</button>
      </template>
    </section>
  </section>
</template>

<style scoped>
.refund-panel { overflow-wrap: anywhere; }
.refund-panel label { display: block; margin: 12px 0; }
.refund-panel button { margin: 4px 8px 4px 0; }
.refund-panel article, .refund-panel section { margin-top: 16px; }
.refund-panel p { line-height: 1.6; }
</style>
