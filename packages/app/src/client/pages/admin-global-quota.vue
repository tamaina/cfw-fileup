<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { authStore, authHeaders } from '../store/auth';
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
		const res = await fetch('/api/admin/get-global-quota', { headers: authHeaders() });
		if (!res.ok) throw new Error('グローバルクォータの取得に失敗しました');
		const data = await res.json() as Record<string, number | null>;
		quota.value = {
			maxBuckets: data.maxBuckets != null ? String(data.maxBuckets) : '',
			maxBucketSizeBytes: data.maxBucketSizeBytes != null ? String(data.maxBucketSizeBytes) : '',
			maxFilesPerBucket: data.maxFilesPerBucket != null ? String(data.maxFilesPerBucket) : '',
			maxDailyUploads: data.maxDailyUploads != null ? String(data.maxDailyUploads) : '',
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
		const res = await fetch('/api/admin/set-global-quota', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error('保存に失敗しました');
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
    <h2>グローバルクォータ設定</h2>
    <NirA to="/admin">← 管理パネルに戻る</NirA>

    <div v-if="!authStore.user?.isAdmin" style="color:red; margin-top:12px">
      管理者権限が必要です。
    </div>

    <template v-else>
      <p style="color:#666; margin-top:12px; font-size:0.9em">
        全ユーザーに適用されるデフォルト値です。ユーザー個別設定がある場合はそちらが優先されます。空欄は無制限。
      </p>

      <p v-if="error" style="color:red">{{ error }}</p>
      <p v-if="success" style="color:green">{{ success }}</p>

      <div v-if="loading">読み込み中...</div>
      <form v-else @submit.prevent="saveQuota" style="display:grid; gap:10px; max-width:400px; margin-top:16px">
        <label>
          バケット数上限<br>
          <input v-model="quota.maxBuckets" type="number" min="0" placeholder="無制限" style="width:100%">
        </label>
        <label>
          バケットサイズ上限 (bytes)<br>
          <input v-model="quota.maxBucketSizeBytes" type="number" min="0" placeholder="無制限" style="width:100%">
        </label>
        <label>
          バケットあたりファイル数上限<br>
          <input v-model="quota.maxFilesPerBucket" type="number" min="0" placeholder="無制限" style="width:100%">
        </label>
        <label>
          1日あたりアップロード数上限<br>
          <input v-model="quota.maxDailyUploads" type="number" min="0" placeholder="無制限" style="width:100%">
        </label>
        <button type="submit" :disabled="saving">保存</button>
      </form>
    </template>
  </div>
</template>
