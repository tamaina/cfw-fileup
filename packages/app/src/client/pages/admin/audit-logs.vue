<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { AlertDialog } from '@vuetify/v0';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import InfiniteTableRow from '@/components/InfiniteTableRow.vue';
import NirA from '@/components/NirA.vue';

type AuditLog = ApiSuccess<'/api/admin/list-moderation-audit-logs'>['data']['items'][number];

const logs = ref<AuditLog[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const dataDialog = ref(false);
const selectedLog = ref<AuditLog | null>(null);

const actionLabels: Record<string, string> = {
	admin_user_suspended: 'ユーザー停止',
	admin_user_unsuspended: 'ユーザー停止解除',
	admin_user_made_admin: '管理者化',
	admin_ip_ban_created: 'IP BAN作成',
	admin_ip_ban_deleted: 'IP BAN削除',
	admin_file_report_updated: '通報更新',
	admin_file_deleted: 'ファイル削除',
	admin_bucket_deleted: 'バケット削除',
	admin_worker_cache_purged: 'Workerキャッシュパージ',
	admin_user_quota_set: 'ユーザークォータ設定',
	admin_user_quota_recalculated: 'ユーザークォータ再計算',
	admin_global_quota_set: 'グローバルクォータ設定',
	admin_user_quota_deleted: 'ユーザークォータ削除',
	admin_setting_updated: '設定更新',
	admin_plan_created: 'プラン作成',
	admin_plan_updated: 'プラン更新',
	admin_user_plan_assigned: 'ユーザープラン割当',
	admin_user_plan_deleted: 'ユーザープラン削除',
	admin_file_previewed: 'ファイルプレビュー',
	admin_file_moderation_forced_private_updated: '強制非公開更新',
	admin_payment_chain_created: '決済チェーン作成',
	admin_payment_chain_updated: '決済チェーン更新',
	admin_payment_chain_deleted: '決済チェーン削除',
	admin_payment_asset_created: '決済通貨作成',
	admin_payment_asset_updated: '決済通貨更新',
	admin_payment_asset_deleted: '決済通貨削除',
	admin_payment_deployment_created: '決済デプロイメント作成',
	admin_payment_deployment_updated: '決済デプロイメント更新',
	admin_payment_price_created: '決済価格作成',
	admin_payment_price_updated: '決済価格更新',
	admin_payment_price_deleted: '決済価格削除',
	admin_crypto_payment_order_confirmed: '決済注文確認',
};

onMounted(() => loadLogs());

async function loadLogs(cursor: string | null = null): Promise<void> {
	const isMore = cursor !== null;
	if (isMore) {
		loadingMore.value = true;
	} else {
		loading.value = true;
	}
	error.value = '';
	try {
		const result = await apiPost('/api/admin/list-moderation-audit-logs', { limit: 50, cursor });
		if (!result.ok) throw new Error(result.data.message || '監査ログの取得に失敗しました');
		logs.value = cursor ? [...logs.value, ...result.data.items] : result.data.items;
		nextCursor.value = result.data.nextCursor;
		hasMore.value = result.data.hasMore;
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		if (isMore) {
			loadingMore.value = false;
		} else {
			loading.value = false;
		}
	}
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString();
}

function actionLabel(action: string): string {
	return actionLabels[action] ?? action;
}

function stringifyData(data: AuditLog['data']): string {
	if (data == null) return '-';
	return JSON.stringify(data, null, 2);
}

function dataString(data: AuditLog['data'], key: string): string | null {
	if (data == null) return null;
	const value = data[key];
	return typeof value === 'string' && value !== '' ? value : null;
}

function dataNumber(data: AuditLog['data'], key: string): number | null {
	if (data == null) return null;
	const value = data[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatIdLabel(label: string | null, id: string | number | null): string | null {
	if (label == null && id == null) return null;
	if (label == null) return String(id);
	if (id == null) return label;
	return `${label} (${id})`;
}

function formatDuration(data: AuditLog['data']): string | null {
	const duration = dataNumber(data, 'durationDays');
	if (duration == null) return null;
	const unit = dataString(data, 'durationUnit') ?? 'days';
	const unitLabel = unit === 'months' ? 'か月' : unit === 'years' ? '年' : '日';
	return `${duration}${unitLabel}`;
}

function auditDataSummary(data: AuditLog['data']): string {
	if (data == null) return '-';
	const priceId = dataString(data, 'priceId');
	if (priceId) {
		const parts = [
			formatIdLabel(dataString(data, 'planName'), dataString(data, 'planId')),
			[dataString(data, 'assetSymbol') ?? dataString(data, 'assetName'), dataString(data, 'chainName')].filter(Boolean).join(' / '),
			dataString(data, 'amountBaseUnits') ? `${dataString(data, 'amountBaseUnits')} base units` : null,
			formatDuration(data),
		].filter((part): part is string => part != null && part !== '');
		return `${parts.join(' - ')} (${priceId})`;
	}

	const deploymentId = dataString(data, 'deploymentId');
	if (deploymentId) {
		const label = [dataString(data, 'assetSymbol') ?? dataString(data, 'assetName'), dataString(data, 'chainName')].filter(Boolean).join(' / ');
		return formatIdLabel(label || null, deploymentId) ?? deploymentId;
	}

	const assetId = dataString(data, 'assetId');
	if (assetId) {
		return formatIdLabel(dataString(data, 'assetSymbol') ?? dataString(data, 'assetName') ?? dataString(data, 'symbol') ?? dataString(data, 'name'), assetId) ?? assetId;
	}

	const chainId = dataNumber(data, 'chainId');
	if (chainId != null) {
		return formatIdLabel(dataString(data, 'chainName') ?? dataString(data, 'name'), chainId) ?? String(chainId);
	}

	const planId = dataString(data, 'planId');
	if (planId) {
		return formatIdLabel(dataString(data, 'planName') ?? dataString(data, 'name'), planId) ?? planId;
	}

	return stringifyData(data).replace(/\s+/g, ' ');
}

function fileUrl(log: AuditLog): string | null {
	const bucketName = dataString(log.data, 'bucketName');
	const path = dataString(log.data, 'path');
	if (!bucketName || !path) return null;
	return `/v/${bucketName}/${path}`;
}

function targetLabel(log: AuditLog): string {
	const user = log.targetUsername && log.targetUserId
		? `${log.targetUsername} (${log.targetUserId})`
		: log.targetUsername ?? log.targetUserId;
	if (log.targetFileId && user) return `${log.targetFileId} / ${user}`;
	return log.targetFileId ?? user ?? '-';
}

function openDataDialog(log: AuditLog): void {
	selectedLog.value = log;
	dataDialog.value = true;
}
</script>

<template>
  <div>
    <NirA to="/admin" class="back-link">← 管理パネルに戻る</NirA>

    <div class="section-header">
      <h2 class="section-title">監査ログ</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>

      <div class="flex items-center gap-2 mb-4">
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="loadLogs()">
          再読み込み
        </button>
      </div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>

      <div v-else :class="['card', $style.tableCard]">
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>操作</th>
                <th>管理者</th>
                <th>対象</th>
                <th>データ</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="log in logs" :key="log.id">
                <td class="col-muted">{{ formatDate(log.createdAt) }}</td>
                <td><span class="badge badge-info">{{ actionLabel(log.action) }}</span></td>
                <td>
                  {{ log.adminUsername ?? '-' }}
                </td>
                <td>
                  <NirA v-if="fileUrl(log)" :to="fileUrl(log)!">{{ targetLabel(log) }}</NirA>
                  <span v-else>{{ targetLabel(log) }}</span>
                </td>
                <td>
                  <button class="btn btn-secondary" type="button" :disabled="log.data == null" @click="openDataDialog(log)">
                    詳細
                  </button>
                </td>
              </tr>
              <tr v-if="logs.length === 0">
                <td colspan="5">
                  <div class="empty-state">
                    <p>監査ログはありません。</p>
                  </div>
                </td>
              </tr>
              <InfiniteTableRow
                v-if="hasMore || loadingMore"
                :colspan="5"
                :has-more="hasMore"
                :loading="loadingMore"
                @load-more="loadLogs(nextCursor)"
              />
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog.Root v-model="dataDialog">
        <AlertDialog.Content :class="$style.dataDialog">
          <AlertDialog.Title :class="$style.dataDialogTitle">監査ログデータ</AlertDialog.Title>
          <div v-if="selectedLog?.data" :class="$style.dataDialogSummary">
            {{ auditDataSummary(selectedLog.data) }}
          </div>
          <pre :class="$style.dataPre">{{ stringifyData(selectedLog?.data ?? null) }}</pre>
          <div :class="$style.dataDialogActions">
            <AlertDialog.Cancel class="btn btn-primary" type="button">閉じる</AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </template>
  </div>
</template>

<style module lang="scss">
.tableCard {
  padding: 0;
  overflow: hidden;
}

.dataDialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 20px;
  width: min(720px, calc(100vw - 32px));
  max-height: 85vh;
  overflow: auto;
}

.dataDialog::backdrop {
  background: rgba(0, 0, 0, 0.45);
}

.dataDialogTitle {
  margin: 0 0 12px;
  font-size: 1.1rem;
}

.dataDialogSummary {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-secondary);
  font-size: 0.875rem;
}

.dataPre {
  max-height: 60vh;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-secondary);
  font-family: monospace;
  font-size: 0.8125rem;
  white-space: pre-wrap;
}

.dataDialogActions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
