<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import * as v from 'valibot';
import type { FileVisibility } from '../../../shared/file-visibility';
import { Button } from '@vuetify/v0';
import NirA from '@/components/NirA.vue';
import InfiniteTableRow from '@/components/InfiniteTableRow.vue';
import SettingItem from '@/components/SettingItem.vue';
import ByteSizeSettingItem from '@/components/ByteSizeSettingItem.vue';
import { authStore } from '@/store/auth';
import { apiPost } from '@/utils/api';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { connectUploadWorker, uploadWorkerJobs } from '@/store/upload-worker';
import { cancelMediaConversionWorker, mediaConversionJobs, type MediaConversionJobSnapshot } from '@/store/media-conversion-worker';
import { formatBytes } from '@/utils/byte-size';
import {
	browserUploadAutoOpen,
	browserUploadNotificationPermission,
	browserUploadNotificationsEnabled,
	browserUploadNonResumeLimitBytes,
	browserUploadPartSizeBytes,
	isBrowserUploadNotificationSupported,
	MIN_BROWSER_UPLOAD_SETTING_BYTES,
	setBrowserUploadAutoOpen,
	setBrowserUploadNotificationsEnabled,
	setBrowserUploadNonResumeLimitBytes,
	setBrowserUploadPartSizeBytes,
} from '@/store/browser-upload-settings';

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
const loadingMore = ref(false);
const error = ref('');
const deleteErrors = ref<Record<string, string>>({});
const activeTab = ref<'server' | 'browser' | 'settings'>('server');
const notificationSaving = ref(false);

const deleteDialog = ref(false);
const deleteTarget = ref<UploadEntry | null>(null);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const booleanSettingSchema = v.picklist(['true', 'false']);
const uploadSizeSettingSchema = v.pipe(
	v.number('数値を入力してください'),
	v.integer('整数を入力してください'),
	v.minValue(MIN_BROWSER_UPLOAD_SETTING_BYTES, '32MiB以上の値を入力してください'),
);
const autoOpenSetting = computed<'true' | 'false'>({
	get: () => browserUploadAutoOpen.value ? 'true' : 'false',
	set: value => setBrowserUploadAutoOpen(value === 'true'),
});
const notificationSetting = computed<'true' | 'false'>({
	get: () => browserUploadNotificationsEnabled.value ? 'true' : 'false',
	set: value => {
		void updateNotificationSetting(value === 'true');
	},
});
const notificationSettingDescription = computed(() => {
	if (!isBrowserUploadNotificationSupported()) return 'このブラウザはOS通知に対応していません。';
	if (browserUploadNotificationPermission.value === 'denied') return 'ブラウザ設定から通知を許可してください。';
	if (browserUploadNotificationPermission.value === 'default') return '有効にするとブラウザの通知許可を求めます。';
	return 'アップロード中の進捗と完了/失敗をOS通知で知らせます。';
});
const partSizeSetting = computed<number | null>({
	get: () => browserUploadPartSizeBytes.value,
	set: value => setBrowserUploadPartSizeBytes(value ?? MIN_BROWSER_UPLOAD_SETTING_BYTES),
});
const nonResumeLimitSetting = computed<number | null>({
	get: () => browserUploadNonResumeLimitBytes.value,
	set: value => setBrowserUploadNonResumeLimitBytes(value ?? MIN_BROWSER_UPLOAD_SETTING_BYTES),
});

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

function mediaConversionProgressPercent(job: MediaConversionJobSnapshot): number {
	if (job.status === 'done') return 100;
	if (job.progress != null) return Math.min(100, Math.round(job.progress * 100));
	if (job.totalFiles <= 0) return 0;
	return Math.min(100, Math.round(job.fileIndex / job.totalFiles * 100));
}

function mediaConversionFileIndex(job: MediaConversionJobSnapshot): number {
	if (job.status === 'done') return job.totalFiles;
	if (job.totalFiles <= 0) return 0;
	return Math.min(job.totalFiles, job.fileIndex + 1);
}

function mediaConversionStatusLabel(job: MediaConversionJobSnapshot): string {
	if (job.status === 'done') return '完了';
	if (job.status === 'error') return 'エラー';
	if (job.status === 'cancelled') return 'キャンセル';
	return job.phase === 'writing' ? '書き込み中' : '変換中';
}

function cancelMediaConversion(job: MediaConversionJobSnapshot): void {
	if (job.status !== 'running') return;
	cancelMediaConversionWorker(job.id);
}

async function updateNotificationSetting(value: boolean): Promise<void> {
	notificationSaving.value = true;
	try {
		await setBrowserUploadNotificationsEnabled(value);
	} finally {
		notificationSaving.value = false;
	}
}

async function load(cursor: string | null = null): Promise<void> {
	const isMore = cursor !== null;
	if (isMore) {
		loadingMore.value = true;
	} else {
		loading.value = true;
	}
	error.value = '';
	try {
		const result = await apiPost('/api/files/uploadings', { limit: 50, cursor });
		if (!result.ok) { error.value = result.data.message; return; }
		entries.value = cursor ? [...entries.value, ...result.data.items] : result.data.items;
		nextCursor.value = result.data.nextCursor;
		hasMore.value = result.data.hasMore;
	} catch (e) {
		error.value = String(e);
	} finally {
		if (isMore) {
			loadingMore.value = false;
		} else {
			loading.value = false;
		}
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
		deleteErrors.value[entry.id] = result.data.message ?? '削除失敗';
		return;
	}
	await load();
}

onMounted(() => {
	const tab = new URLSearchParams(location.search).get('tab');
	activeTab.value = tab === 'browser' || tab === 'settings' ? tab : 'server';
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
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'settings' }" @click="activeTab = 'settings'">設定</button>
      </div>

      <div v-if="activeTab === 'browser'">
        <div v-if="uploadWorkerJobs.length === 0 && mediaConversionJobs.length === 0" class="empty-state">
          <p>ブラウザから実行中のアップロードはありません。</p>
        </div>
        <div v-if="mediaConversionJobs.length > 0" :class="[$style.tableCard, 'card', $style.browserSection]">
          <div :class="$style.browserSectionHeader">
            <h3>メディア変換</h3>
          </div>
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>状態</th>
                  <th>対象</th>
                  <th class="col-right">ファイル数</th>
                  <th class="col-usage">進捗</th>
                  <th>更新日時</th>
                  <th class="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="job in mediaConversionJobs" :key="job.id">
                  <td>
                    <span :class="job.status === 'done' ? 'badge badge-success' : job.status === 'error' || job.status === 'cancelled' ? 'badge badge-danger' : 'badge badge-info'">
                      {{ mediaConversionStatusLabel(job) }}
                    </span>
                  </td>
                  <td>
                    <span class="font-mono">{{ job.filename || job.title }}</span>
                    <div class="col-muted">{{ job.title }}</div>
                    <div v-if="job.error" class="text-danger">{{ job.error }}</div>
                    <div v-else-if="job.fallbackError" class="text-danger">一部を元ファイルで処理しました: {{ job.fallbackError }}</div>
                  </td>
                  <td class="col-right col-muted">
                    <template v-if="job.totalFiles > 0">{{ mediaConversionFileIndex(job) }}/{{ job.totalFiles }}</template>
                  </td>
                  <td>
                    <div class="bucket-usage">
                      <div class="bucket-usage-bar">
                        <div class="bucket-usage-bar-fill" :style="{ width: `${mediaConversionProgressPercent(job)}%` }" />
                      </div>
                      <span class="bucket-usage-pct">{{ mediaConversionProgressPercent(job) }}%</span>
                    </div>
                  </td>
                  <td class="col-muted">{{ formatDate(job.updatedAt) }}</td>
                  <td class="col-actions">
                    <Button.Root
                      v-if="job.status === 'running'"
                      class="btn btn-ghost-danger btn-sm"
                      @click="cancelMediaConversion(job)"
                    >
                      <Button.Content>キャンセル</Button.Content>
                    </Button.Root>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="uploadWorkerJobs.length > 0" :class="[$style.tableCard, 'card', $style.browserSection]">
          <div :class="$style.browserSectionHeader">
            <h3>アップロード</h3>
          </div>
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

      <div v-else-if="activeTab === 'settings'" :class="$style.settingsGrid">
        <SettingItem
          v-model="autoOpenSetting"
          :schema="booleanSettingSchema"
          title="完了後に開く"
          :show-save-button="false"
          :option-labels="{ true: '有効', false: '無効' }"
        >
          アップロード画面を開いたままの場合、完了したファイルへ移動します。
        </SettingItem>
        <SettingItem
          v-model="notificationSetting"
          :schema="booleanSettingSchema"
          title="OS通知"
          :saving="notificationSaving"
          :show-save-button="false"
          :option-labels="{ true: '有効', false: '無効' }"
        >
          {{ notificationSettingDescription }}
        </SettingItem>
        <ByteSizeSettingItem
          v-model="partSizeSetting"
          :schema="uploadSizeSettingSchema"
          title="チャンクサイズ"
          :show-save-button="false"
        >
          分割アップロードの1チャンクごとのサイズです。32MiB以上を指定できます。
        </ByteSizeSettingItem>
        <ByteSizeSettingItem
          v-model="nonResumeLimitSetting"
          :schema="uploadSizeSettingSchema"
          title="非分割アップロード上限"
          :show-save-button="false"
        >
          このサイズ未満のファイルは分割アップロードにしません。32MiB以上を指定できます。
        </ByteSizeSettingItem>
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
              <InfiniteTableRow
                v-if="hasMore || loadingMore"
                :colspan="6"
                :has-more="hasMore"
                :loading="loadingMore"
                @load-more="load(nextCursor)"
              />
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

.browserSection {
  margin-bottom: 16px;
}

.browserSectionHeader {
  padding: 14px 16px 0;

  h3 {
    margin: 0 0 10px;
    font-size: 1rem;
  }
}

.statusBadge {
  margin-left: 4px;
}

.deleteError {
  font-size: 0.8rem;
}

.settingsGrid {
  display: grid;
  gap: 12px;
}
</style>
