<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button } from '@vuetify/v0';
import { authStore, authHeaders } from '../store/auth';
import NirA from '@/components/nira.vue';
import ConfirmDialog from '@/components/confirm-dialog.vue';

const props = defineProps<{ userId: string }>();

interface QuotaForm {
	maxBuckets: string;
	maxBucketSizeBytes: string;
	maxFilesPerBucket: string;
	maxDailyUploads: string;
}

const quota = ref<QuotaForm>({ maxBuckets: '', maxBucketSizeBytes: '', maxFilesPerBucket: '', maxDailyUploads: '' });
const loading = ref(true);
const saving = ref(false);
const deleting = ref(false);
const error = ref('');
const success = ref('');
const hasUserQuota = ref(false);
const resetDialog = ref(false);

onMounted(fetchQuota);

async function fetchQuota(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const [userRes, globalRes] = await Promise.all([
			fetch(`/api/admin/get-user-quota/${props.userId}`, { headers: authHeaders() }),
			fetch('/api/admin/get-global-quota', { headers: authHeaders() }),
		]);
		if (!userRes.ok) throw new Error('クォータの取得に失敗しました');
		const userData = await userRes.json() as Record<string, number | null>;
		const globalData = globalRes.ok ? await globalRes.json() as Record<string, number | null> : {};

		hasUserQuota.value =
			userData.maxBuckets !== (globalData.maxBuckets ?? null) ||
			userData.maxBucketSizeBytes !== (globalData.maxBucketSizeBytes ?? null) ||
			userData.maxFilesPerBucket !== (globalData.maxFilesPerBucket ?? null) ||
			userData.maxDailyUploads !== (globalData.maxDailyUploads ?? null);

		quota.value = {
			maxBuckets: userData.maxBuckets != null ? String(userData.maxBuckets) : '',
			maxBucketSizeBytes: userData.maxBucketSizeBytes != null ? String(userData.maxBucketSizeBytes) : '',
			maxFilesPerBucket: userData.maxFilesPerBucket != null ? String(userData.maxFilesPerBucket) : '',
			maxDailyUploads: userData.maxDailyUploads != null ? String(userData.maxDailyUploads) : '',
		};
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function saveQuota(): Promise<void> {
	saving.value = true;
	error.value = '';
	success.value = '';
	try {
		const body = {
			maxBuckets: quota.value.maxBuckets !== '' ? Number(quota.value.maxBuckets) : null,
			maxBucketSizeBytes: quota.value.maxBucketSizeBytes !== '' ? Number(quota.value.maxBucketSizeBytes) : null,
			maxFilesPerBucket: quota.value.maxFilesPerBucket !== '' ? Number(quota.value.maxFilesPerBucket) : null,
			maxDailyUploads: quota.value.maxDailyUploads !== '' ? Number(quota.value.maxDailyUploads) : null,
		};
		const res = await fetch(`/api/admin/set-user-quota/${props.userId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error('保存に失敗しました');
		hasUserQuota.value = true;
		success.value = 'ユーザークォータを保存しました';
	} catch (e) {
		error.value = String(e);
	} finally {
		saving.value = false;
	}
}

async function executeReset(): Promise<void> {
	resetDialog.value = false;
	deleting.value = true;
	error.value = '';
	success.value = '';
	try {
		const res = await fetch(`/api/admin/delete-user-quota/${props.userId}`, {
			method: 'POST',
			headers: authHeaders(),
		});
		if (!res.ok) throw new Error('リセットに失敗しました');
		hasUserQuota.value = false;
		success.value = 'クォータをリセットしました（グローバルデフォルト適用中）';
		await fetchQuota();
	} catch (e) {
		error.value = String(e);
	} finally {
		deleting.value = false;
	}
}
</script>

<template>
  <div>
    <NirA to="/admin/users" class="back-link">← ユーザー一覧に戻る</NirA>

    <div class="section-header">
      <h2 class="section-title">ユーザークォータ設定</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <template v-else>
      <div class="flex gap-2 items-center mb-4">
        <span class="text-muted" style="font-size:0.875rem">ユーザーID:</span>
        <code class="font-mono" style="font-size:0.875rem; background:var(--color-bg); padding:2px 8px; border-radius:4px; border:1px solid var(--color-border)">{{ userId }}</code>
        <span v-if="!hasUserQuota && !loading" class="badge badge-muted">グローバルデフォルト適用中</span>
        <span v-if="hasUserQuota && !loading" class="badge badge-admin">個別クォータ設定あり</span>
      </div>

      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <form v-else @submit.prevent="saveQuota" style="display:flex; flex-direction:column; gap:12px; max-width:400px">
        <p class="text-muted" style="font-size:0.875rem; margin:0">空欄は無制限（またはグローバルデフォルト準拠）。</p>
        <div class="form-group">
          <label class="form-label">バケット数上限</label>
          <input v-model="quota.maxBuckets" class="form-input" type="number" min="0" placeholder="無制限">
        </div>
        <div class="form-group">
          <label class="form-label">バケットサイズ上限 (bytes)</label>
          <input v-model="quota.maxBucketSizeBytes" class="form-input" type="number" min="0" placeholder="無制限">
        </div>
        <div class="form-group">
          <label class="form-label">バケットあたりファイル数上限</label>
          <input v-model="quota.maxFilesPerBucket" class="form-input" type="number" min="0" placeholder="無制限">
        </div>
        <div class="form-group">
          <label class="form-label">1日あたりアップロード数上限</label>
          <input v-model="quota.maxDailyUploads" class="form-input" type="number" min="0" placeholder="無制限">
        </div>
        <div class="flex gap-2">
          <Button.Root type="submit" class="btn btn-primary" :loading="saving">
            <Button.Loading>保存中...</Button.Loading>
            <Button.Content>保存する</Button.Content>
          </Button.Root>
          <Button.Root
            v-if="hasUserQuota"
            type="button"
            class="btn btn-ghost-danger"
            :loading="deleting"
            @click="resetDialog = true"
          >
            <Button.Loading>リセット中...</Button.Loading>
            <Button.Content>リセット（グローバルに戻す）</Button.Content>
          </Button.Root>
        </div>
      </form>
    </template>

    <ConfirmDialog
      v-model:open="resetDialog"
      title="クォータをリセット"
      message="このユーザーのクォータ設定をリセットしてグローバルデフォルトに戻しますか？"
      confirm-label="リセットする"
      :danger="true"
      @confirm="executeReset"
      @cancel="resetDialog = false"
    />
  </div>
</template>
