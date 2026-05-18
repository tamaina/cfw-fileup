<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Button, Popover } from '@vuetify/v0';
import { authHeaders, authStore } from '../store/auth';
import NirA from '@/components/nira.vue';
import ConfirmDialog from '@/components/confirm-dialog.vue';
import { isValidNameFormat, NAME_FORMAT_ERROR } from '../../shared/name-validation';

interface Bucket {
	id: string;
	name: string;
	usedBytes: number;
}

const buckets = ref<Bucket[]>([]);
const maxBucketSizeBytes = ref<number | null>(null);
const error = ref('');
const loading = ref(true);
const newBucketName = ref('');
const creating = ref(false);
const createError = ref('');

/** バケット名の文字種バリデーション（クライアントサイド） */
const bucketNameFormatError = computed(() => {
	if (!newBucketName.value) return '';
	if (!isValidNameFormat(newBucketName.value)) return NAME_FORMAT_ERROR;
	return '';
});

function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function usagePercent(usedBytes: number): number {
	if (!maxBucketSizeBytes.value) return 0;
	return Math.min(100, (usedBytes / maxBucketSizeBytes.value) * 100);
}

const deleteDialog = ref(false);
const deleteTarget = ref<Bucket | null>(null);

async function loadBuckets(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch('/api/buckets/list', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({}),
		});
		const data = (await res.json()) as { buckets?: Bucket[]; maxBucketSizeBytes?: number | null; error?: string };
		if (!res.ok) {
			error.value = data.error ?? 'バケット一覧の取得に失敗しました';
			return;
		}
		buckets.value = data.buckets ?? [];
		maxBucketSizeBytes.value = data.maxBucketSizeBytes ?? null;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function createBucket(): Promise<void> {
	if (!newBucketName.value.trim()) return;
	if (bucketNameFormatError.value) {
		createError.value = bucketNameFormatError.value;
		return;
	}
	creating.value = true;
	createError.value = '';
	try {
		const res = await fetch('/api/buckets/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ bucketName: newBucketName.value.trim() }),
		});
		const data = (await res.json()) as { bucketId?: string; error?: string };
		if (!res.ok) {
			createError.value = data.error ?? 'バケットの作成に失敗しました';
			return;
		}
		newBucketName.value = '';
		await loadBuckets();
	} catch (e) {
		createError.value = String(e);
	} finally {
		creating.value = false;
	}
}

function requestDelete(bucket: Bucket): void {
	deleteTarget.value = bucket;
	deleteDialog.value = true;
}

async function executeDeletion(): Promise<void> {
	if (!deleteTarget.value) return;
	const { id: bucketId } = deleteTarget.value;
	deleteDialog.value = false;
	deleteTarget.value = null;
	try {
		const res = await fetch('/api/buckets/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ bucketId }),
		});
		if (!res.ok) {
			const data = (await res.json()) as { error?: string };
			error.value = data.error ?? '削除に失敗しました';
			return;
		}
		await loadBuckets();
	} catch (e) {
		error.value = String(e);
	}
}

onMounted(loadBuckets);
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">マイバケット</h2>
    </div>

    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>

    <template v-else>
      <!-- 作成フォーム -->
      <div class="card mb-4">
        <p class="card-title">新しいバケットを作成</p>
        <form @submit.prevent="createBucket" class="form-row">
          <div style="display:flex; flex-direction:column; gap:4px">
            <input
              v-model="newBucketName"
              class="form-input"
              type="text"
              placeholder="バケット名"
              maxlength="64"
              style="max-width:280px"
            >
            <div v-if="bucketNameFormatError" class="form-hint form-hint--error">{{ bucketNameFormatError }}</div>
            <div v-else class="form-hint">英数字とアンダースコア [0-9a-zA-Z_] のみ使用できます</div>
          </div>
          <Button.Root type="submit" class="btn btn-primary" :loading="creating" :disabled="!!bucketNameFormatError">
            <Button.Loading>作成中...</Button.Loading>
            <Button.Content>作成</Button.Content>
          </Button.Root>
        </form>
        <div v-if="createError" class="alert alert-error mt-2">{{ createError }}</div>
      </div>

      <!-- 一覧 -->
      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <div v-else-if="error" class="alert alert-error">{{ error }}</div>
      <template v-else>
        <div v-if="buckets.length === 0" class="empty-state">
          <p>バケットがありません。上のフォームから作成してください。</p>
        </div>
        <div v-else class="card" style="padding:0; overflow:hidden">
          <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>バケット名</th>
                <th class="col-usage">使用量</th>
                <th class="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in buckets" :key="b.id">
                <td>
                  <NirA :to="`/v/${b.name}/`" style="font-weight:500; font-size:0.9375rem">
                    {{ b.name }}
                  </NirA>
                </td>
                <td class="col-usage">
                  <div class="bucket-usage">
                    <span class="bucket-usage-text">
                      {{ formatBytes(b.usedBytes) }}
                      <template v-if="maxBucketSizeBytes != null"> / {{ formatBytes(maxBucketSizeBytes) }}</template>
                    </span>
                    <template v-if="maxBucketSizeBytes != null">
                      <div class="bucket-usage-bar">
                        <div
                          class="bucket-usage-bar-fill"
                          :class="{ 'bucket-usage-bar-fill--danger': usagePercent(b.usedBytes) >= 90 }"
                          :style="{ width: `${usagePercent(b.usedBytes).toFixed(1)}%` }"
                        />
                      </div>
                      <span class="bucket-usage-pct">{{ usagePercent(b.usedBytes).toFixed(1) }}%</span>
                    </template>
                  </div>
                </td>
                <td class="col-actions">
                  <div class="flex gap-2 items-center">
                    <NirA :to="`/my/buckets/${b.name}/upload`" class="btn btn-secondary">
                      アップロード
                    </NirA>
                    <Popover.Root>
                      <Popover.Activator>
                        <Button.Root class="btn btn-ghost btn-icon" aria-label="操作メニュー">
                          <Button.Content>…</Button.Content>
                        </Button.Root>
                      </Popover.Activator>
                      <Popover.Content class="action-menu">
                        <Button.Root class="btn btn-ghost-danger w-full" style="justify-content:flex-start" @click="requestDelete(b)">
                          <Button.Content>削除</Button.Content>
                        </Button.Root>
                      </Popover.Content>
                    </Popover.Root>
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
      title="バケットを削除"
      :message="deleteTarget ? `「${deleteTarget.name}」を削除しますか？中のファイルもすべて削除されます。` : ''"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeDeletion"
      @cancel="deleteDialog = false"
    />
  </div>
</template>
