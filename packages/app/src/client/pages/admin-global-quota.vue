<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button } from '@vuetify/v0';
import { authStore } from '../store/auth';
import { apiPost } from '../utils/api';
import NirA from '@/components/nira.vue';

interface QuotaForm {
	maxBuckets: string;
	maxBucketSizeBytes: string;
	maxFilesPerBucket: string;
	maxDailyUploads: string;
}

const quota = ref<QuotaForm>({ maxBuckets: '', maxBucketSizeBytes: '', maxFilesPerBucket: '', maxDailyUploads: '' });
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const success = ref('');

onMounted(fetchQuota);

async function fetchQuota(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/admin/get-global-quota');
		if (!result.ok) throw new Error('グローバルクォータの取得に失敗しました');
		quota.value = {
			maxBuckets: result.data.maxBuckets != null ? String(result.data.maxBuckets) : '',
			maxBucketSizeBytes: result.data.maxBucketSizeBytes != null ? String(result.data.maxBucketSizeBytes) : '',
			maxFilesPerBucket: result.data.maxFilesPerBucket != null ? String(result.data.maxFilesPerBucket) : '',
			maxDailyUploads: result.data.maxDailyUploads != null ? String(result.data.maxDailyUploads) : '',
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
		const result = await apiPost('/api/admin/set-global-quota', body);
		if (!result.ok) throw new Error('保存に失敗しました');
		success.value = 'グローバルクォータを保存しました';
	} catch (e) {
		error.value = String(e);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
  <div>
    <NirA to="/admin" class="back-link">← 管理パネルに戻る</NirA>

    <div class="section-header">
      <h2 class="section-title">グローバルクォータ設定</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <template v-else>
      <p class="text-muted mb-4" style="font-size:0.875rem">
        全ユーザーに適用されるデフォルト値です。ユーザー個別設定がある場合はそちらが優先されます。空欄は無制限。
      </p>

      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <form v-else @submit.prevent="saveQuota" style="display:flex; flex-direction:column; gap:12px; max-width:400px">
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
        <div>
          <Button.Root type="submit" class="btn btn-primary" :loading="saving">
            <Button.Loading>保存中...</Button.Loading>
            <Button.Content>保存する</Button.Content>
          </Button.Root>
        </div>
      </form>
    </template>
  </div>
</template>
