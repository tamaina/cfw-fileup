<script setup lang="ts">
import { ref, onMounted } from 'vue';
import * as v from 'valibot';
import { authStore } from '../store/auth';
import { apiPost } from '../utils/api';
import NirA from '@/components/nira.vue';
import SettingItem from '@/components/SettingItem.vue';

interface QuotaForm {
	maxBuckets: number | null;
	maxBucketSizeBytes: number | null;
	maxFilesPerBucket: number | null;
	maxDailyUploads: number | null;
}

const quotaValueSchema = v.nullable(v.pipe(
	v.number(),
	v.integer('整数を入力してください'),
	v.minValue(0, '0以上の数値を入力してください'),
));

const quota = ref<QuotaForm>({ maxBuckets: null, maxBucketSizeBytes: null, maxFilesPerBucket: null, maxDailyUploads: null });
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
			maxBuckets: result.data.maxBuckets ?? null,
			maxBucketSizeBytes: result.data.maxBucketSizeBytes ?? null,
			maxFilesPerBucket: result.data.maxFilesPerBucket ?? null,
			maxDailyUploads: result.data.maxDailyUploads ?? null,
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
		const result = await apiPost('/api/admin/set-global-quota', { ...quota.value });
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
      <p :class="[$style.description, 'text-muted', 'mb-4']">
        全ユーザーに適用されるデフォルト値です。ユーザー個別設定がある場合はそちらが優先されます。空欄は無制限。
      </p>

      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <div v-else :class="$style.settingsGrid">
        <SettingItem
          v-model="quota.maxBuckets"
          :schema="quotaValueSchema"
          title="バケット数上限"
          :saving="saving"
          @save="saveQuota"
        />
        <SettingItem
          v-model="quota.maxBucketSizeBytes"
          :schema="quotaValueSchema"
          title="バケットサイズ上限 (bytes)"
          :saving="saving"
          @save="saveQuota"
        />
        <SettingItem
          v-model="quota.maxFilesPerBucket"
          :schema="quotaValueSchema"
          title="バケットあたりファイル数上限"
          :saving="saving"
          @save="saveQuota"
        />
        <SettingItem
          v-model="quota.maxDailyUploads"
          :schema="quotaValueSchema"
          title="1日あたりアップロード数上限"
          :saving="saving"
          @save="saveQuota"
        />
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
.description {
  font-size: 0.875rem;
}

.settingsGrid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 700px;
}
</style>
