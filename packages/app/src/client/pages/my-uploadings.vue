<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { FileVisibility } from '../../shared/file-visibility';
import { Button } from '@vuetify/v0';
import NirA from '@/components/nira.vue';
import { authStore } from '@/store/auth';
import { apiPost } from '@/utils/api';
import ConfirmDialog from '@/components/confirm-dialog.vue';
import { connectUploadWorker, uploadWorkerJobs } from '@/store/upload-worker';

interface UploadEntry {
	id: string;
	bucketId: string;
	bucketName: string;
	path: string;
	size: number | null;
	isClosed: boolean;
	visibility: FileVisibility;
	uploadExpiresAt: number;
	isTargz: boolean;
	isTar: boolean;
}

const entries = ref<UploadEntry[]>([]);
const loading = ref(true);
const error = ref('');
const deleteErrors = ref<Record<string, string>>({});
const activeTab = ref<'server' | 'browser'>('server');

const deleteDialog = ref(false);
const deleteTarget = ref<UploadEntry | null>(null);

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileLabel(e: UploadEntry): string {
	if (e.isTargz) return 'tar.gz';
	if (e.isTar) return 'tar';
	return '';
}

function browseLink(e: UploadEntry): string {
	return `/v/${e.bucketName}/${e.path}`;
}

function browserUploadLink(bucketName: string, path: string): string {
	return `/v/${bucketName}/${path}`;
}

function formatDate(timestamp: number): string {
	return new Date(timestamp).toLocaleString();
}

function progressPercent(uploadedBytes: number, totalBytes: number): number {
	if (totalBytes <= 0) return 0;
	return Math.min(100, Math.round(uploadedBytes / totalBytes * 100));
}

async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/files/uploadings');
		if (!result.ok) { error.value = result.data.error; return; }
		entries.value = result.data.files;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

function requestDelete(entry: UploadEntry): void {
	deleteTarget.value = entry;
	deleteDialog.value = true;
}

async function executeDelete(): Promise<void> {
	if (!deleteTarget.value) return;
	const entry = deleteTarget.value;
	deleteDialog.value = false;
	deleteTarget.value = null;
	delete deleteErrors.value[entry.id];

	const result = await apiPost('/api/files/delete', { bucketId: entry.bucketId, path: entry.path });
	if (!result.ok) {
		deleteErrors.value[entry.id] = result.data.error ?? '削除失敗';
		return;
	}
	await load();
}

onMounted(() => {
	activeTab.value = new URLSearchParams(location.search).get('tab') === 'browser' ? 'browser' : 'server';
	connectUploadWorker();
	void load();
});
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">マイアップロード</h2>
    </div>

    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>
    <template v-else>
      <div class="tab-bar mb-4">
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'browser' }" @click="activeTab = 'browser'">このブラウザ</button>
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'server' }" @click="activeTab = 'server'">サーバー</button>
      </div>

      <div v-if="activeTab === 'browser'">
        <div v-if="uploadWorkerJobs.length === 0" class="empty-state">
          <p>ブラウザから実行中のアップロードはありません。</p>
        </div>
        <div v-else :class="[$style.tableCard, 'card']">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>状態</th>
                  <th>バケット</th>
                  <th>対象</th>
                  <th class="col-right">ファイル数</th>
                  <th class="col-usage">進捗</th>
                  <th class="col-right">転送量</th>
                  <th>更新日時</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="job in uploadWorkerJobs" :key="job.id">
                  <td>
                    <span :class="job.status === 'done' ? 'badge badge-success' : job.status === 'error' ? 'badge badge-danger' : job.status === 'queued' ? 'badge badge-muted' : 'badge badge-info'">
                      {{ job.status === 'done' ? '完了' : job.status === 'error' ? 'エラー' : job.status === 'queued' ? '待機中' : 'アップロード中' }}
                    </span>
                  </td>
                  <td class="col-muted">{{ job.bucketName }}</td>
                  <td>
                    <NirA v-if="job.status === 'done' && job.completedPath" :to="browserUploadLink(job.bucketName, job.completedPath)" class="font-mono">
                      {{ job.completedPath }}
                    </NirA>
                    <span v-else class="font-mono">{{ job.filename || job.prefix || '-' }}</span>
                    <div v-if="job.error" class="text-danger">{{ job.error }}</div>
                  </td>
                  <td class="col-right col-muted">
                    <template v-if="job.totalFiles > 0">{{ job.fileIndex }}/{{ job.totalFiles }}</template>
                  </td>
                  <td>
                    <div class="bucket-usage">
                      <div class="bucket-usage-bar">
                        <div class="bucket-usage-bar-fill" :style="{ width: `${progressPercent(job.uploadedBytes, job.totalBytes)}%` }" />
                      </div>
                      <span class="bucket-usage-pct">{{ progressPercent(job.uploadedBytes, job.totalBytes) }}%</span>
                    </div>
                  </td>
                  <td class="col-right col-muted">
                    <template v-if="progressPercent(job.uploadedBytes, job.totalBytes) >= 100">
                      {{ formatBytes(job.totalBytes) }}
                    </template>
                    <template v-else>
                      {{ formatBytes(job.uploadedBytes) }} / {{ formatBytes(job.totalBytes) }}
                    </template>
                  </td>
                  <td class="col-muted">{{ formatDate(job.updatedAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div v-else-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <div v-else-if="error" class="alert alert-error">{{ error }}</div>
      <template v-else>
        <div v-if="entries.length === 0" class="empty-state">
          <p>アップロードはありません。</p>
        </div>
        <div v-else :class="[$style.tableCard, 'card']">
          <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>バケット</th>
                <th>パス</th>
                <th class="col-right">サイズ</th>
                <th>種類</th>
                <th>状態</th>
                <th class="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in entries" :key="entry.id">
                <td class="col-muted">{{ entry.bucketName }}</td>
                <td>
                  <NirA v-if="entry.isClosed" :to="browseLink(entry)" class="font-mono">{{ entry.path }}</NirA>
                  <span v-else class="col-muted font-mono">{{ entry.path }}</span>
                </td>
                <td class="col-right col-muted">
                  {{ entry.size != null ? formatBytes(entry.size) : '' }}
                </td>
                <td>
                  <span v-if="fileLabel(entry)" class="badge badge-muted">{{ fileLabel(entry) }}</span>
                </td>
                <td>
                  <span v-if="entry.isClosed" class="badge badge-success">完了</span>
                  <span v-else class="badge badge-warning">アップロード中</span>
                  <span v-if="entry.isClosed" :class="[entry.visibility === 'public' ? 'badge badge-success' : entry.visibility === 'passphrase' ? 'badge badge-warning' : 'badge badge-muted', $style.statusBadge]">
                    {{ entry.visibility === 'public' ? '公開' : entry.visibility === 'passphrase' ? '合言葉' : '非公開' }}
                  </span>
                </td>
                <td class="col-actions">
                  <div class="flex gap-2 items-center">
                    <Button.Root class="btn btn-ghost-danger" @click="requestDelete(entry)">
                      <Button.Content>削除</Button.Content>
                    </Button.Root>
                    <span v-if="deleteErrors[entry.id]" :class="[$style.deleteError, 'text-danger']">{{ deleteErrors[entry.id] }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </template>
    </template>

    <ConfirmDialog
      v-model:open="deleteDialog"
      :title="deleteTarget?.isClosed ? 'ファイルを削除' : 'アップロードをキャンセル'"
      :message="deleteTarget ? `「${deleteTarget.path}」を削除しますか？` : ''"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeDelete"
      @cancel="deleteDialog = false"
    />
  </div>
</template>

<style module lang="scss">
.tableCard {
  padding: 0;
  overflow: hidden;
}

.statusBadge {
  margin-left: 4px;
}

.deleteError {
  font-size: 0.8rem;
}
</style>
