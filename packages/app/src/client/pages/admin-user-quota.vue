<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { authStore, authHeaders } from '../store/auth';
import NirA from '@/components/nira.vue';

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

onMounted(fetchQuota);

async function fetchQuota(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		// Check if user-specific quota exists by comparing with global
		const [userRes, globalRes] = await Promise.all([
			fetch(`/api/admin/get-user-quota/${props.userId}`, { headers: authHeaders() }),
			fetch('/api/admin/get-global-quota', { headers: authHeaders() }),
		]);
		if (!userRes.ok) throw new Error('クォータの取得に失敗しました');
		const userData = await userRes.json() as Record<string, number | null>;
		const globalData = globalRes.ok ? await globalRes.json() as Record<string, number | null> : {};

		// user-specific quota exists if any value differs from global (or global is null and user is set)
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

async function deleteQuota(): Promise<void> {
	if (!confirm('このユーザーのクォータ設定をリセットしてグローバルデフォルトに戻しますか？')) return;
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
    <h2>ユーザークォータ設定</h2>
    <NirA to="/admin/users">← ユーザー一覧に戻る</NirA>

    <div v-if="!authStore.user?.isAdmin" style="color:red; margin-top:12px">
      管理者権限が必要です。
    </div>

    <template v-else>
      <p style="color:#666; margin-top:12px; font-size:0.9em">
        ユーザーID: <code>{{ userId }}</code>
      </p>
      <p v-if="!hasUserQuota && !loading" style="color:#666; font-size:0.9em">
        現在はグローバルデフォルトが適用されています。
      </p>
      <p v-if="hasUserQuota && !loading" style="color:#6200ea; font-size:0.9em">
        このユーザーには個別クォータが設定されています。
      </p>

      <p v-if="error" style="color:red">{{ error }}</p>
      <p v-if="success" style="color:green">{{ success }}</p>

      <div v-if="loading">読み込み中...</div>
      <form v-else @submit.prevent="saveQuota" style="display:grid; gap:10px; max-width:400px; margin-top:16px">
        <p style="color:#666; font-size:0.9em; margin:0">空欄は無制限（またはグローバルデフォルト準拠）。</p>
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
        <div style="display:flex; gap:8px">
          <button type="submit" :disabled="saving">保存</button>
          <button
            v-if="hasUserQuota"
            type="button"
            :disabled="deleting"
            @click="deleteQuota"
            style="color:red"
          >
            リセット（グローバルに戻す）
          </button>
        </div>
      </form>
    </template>
  </div>
</template>
