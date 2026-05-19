<script setup lang="ts">
import { ref, onMounted } from 'vue';
import * as v from 'valibot';
import { Button } from '@vuetify/v0';
import { authStore } from '../store/auth';
import { apiPost } from '../utils/api';
import NirA from '@/components/nira.vue';
import ConfirmDialog from '@/components/confirm-dialog.vue';
import SettingItem from '@/components/SettingItem.vue';

const props = defineProps<{ userId: string }>();

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
		const [userResult, globalResult] = await Promise.all([
			apiPost('/api/admin/get-user-quota', { userId: props.userId }),
			apiPost('/api/admin/get-global-quota'),
		]);
		if (!userResult.ok) throw new Error('クォータの取得に失敗しました');
		const userData = userResult.data;
		const globalData = globalResult.ok ? globalResult.data : { maxBuckets: null, maxBucketSizeBytes: null, maxFilesPerBucket: null, maxDailyUploads: null };

		hasUserQuota.value =
			userData.maxBuckets !== (globalData.maxBuckets ?? null) ||
			userData.maxBucketSizeBytes !== (globalData.maxBucketSizeBytes ?? null) ||
			userData.maxFilesPerBucket !== (globalData.maxFilesPerBucket ?? null) ||
			userData.maxDailyUploads !== (globalData.maxDailyUploads ?? null);

		quota.value = {
			maxBuckets: userData.maxBuckets ?? null,
			maxBucketSizeBytes: userData.maxBucketSizeBytes ?? null,
			maxFilesPerBucket: userData.maxFilesPerBucket ?? null,
			maxDailyUploads: userData.maxDailyUploads ?? null,
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
		const result = await apiPost('/api/admin/set-user-quota', { userId: props.userId, ...quota.value });
		if (!result.ok) throw new Error('保存に失敗しました');
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
		const result = await apiPost('/api/admin/delete-user-quota', { userId: props.userId });
		if (!result.ok) throw new Error('リセットに失敗しました');
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
      <div :class="[$style.userIdRow, 'flex', 'gap-2', 'items-center', 'mb-4']">
        <span :class="['text-muted', $style.smallText]">ユーザーID:</span>
        <code :class="[$style.userId, 'font-mono']">{{ userId }}</code>
        <span v-if="!hasUserQuota && !loading" class="badge badge-muted">グローバルデフォルト適用中</span>
        <span v-if="hasUserQuota && !loading" class="badge badge-admin">個別クォータ設定あり</span>
      </div>

      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <div v-else :class="$style.settingsGrid">
        <p :class="['text-muted', $style.formHint]">空欄は無制限（またはグローバルデフォルト準拠）。</p>
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
        <div class="flex gap-2">
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
      </div>
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

<style module lang="scss">
.smallText {
  font-size: 0.875rem;
}

.userId {
  font-size: 0.875rem;
  background: var(--color-bg);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
}

.settingsGrid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 700px;
}

.formHint {
  font-size: 0.875rem;
  margin: 0;
}

.userIdRow {
  flex-wrap: wrap;
}
</style>
