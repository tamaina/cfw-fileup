<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
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

interface Plan {
	id: string;
	name: string;
}

interface UserPlanAssignment {
	userId: string;
	planId: string;
	planName: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

type ActiveTab = 'billing' | 'custom' | 'reset';

const quotaValueSchema = v.nullable(v.pipe(
	v.number(),
	v.integer('整数を入力してください'),
	v.minValue(0, '0以上の数値を入力してください'),
));

const quota = ref<QuotaForm>({ maxBuckets: null, maxBucketSizeBytes: null, maxFilesPerBucket: null, maxDailyUploads: null });
const plans = ref<Plan[]>([]);
const userPlan = ref<UserPlanAssignment | null>(null);
const selectedPlanId = ref('');
const planExpiresAt = ref('');
const username = ref('');
const activeTab = ref<ActiveTab>('billing');
const loading = ref(true);
const saving = ref(false);
const assigningPlan = ref(false);
const deleting = ref(false);
const deletingPlan = ref(false);
const error = ref('');
const success = ref('');
const hasUserQuota = ref(false);
const resetDialog = ref(false);
const removePlanDialog = ref(false);
const activeUserPlan = computed(() => userPlan.value != null && userPlan.value.expiresAt > Date.now());

onMounted(async () => {
	await Promise.all([fetchQuota(), fetchPlansAndAssignment(), fetchUser()]);
});

async function fetchQuota(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/admin/get-user-custom-quota', { userId: props.userId });
		if (!result.ok) throw new Error('クォータの取得に失敗しました');
		hasUserQuota.value = result.data.exists;
		const userData = result.data.quota;

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

async function fetchUser(): Promise<void> {
	try {
		const result = await apiPost('/api/admin/list-users');
		if (!result.ok) throw new Error('ユーザー情報の取得に失敗しました');
		username.value = result.data.find((user) => user.id === props.userId)?.username ?? '';
	} catch (e) {
		error.value = String(e);
	}
}

async function fetchPlansAndAssignment(): Promise<void> {
	try {
		const [plansResult, assignmentResult] = await Promise.all([
			apiPost('/api/admin/list-plans'),
			apiPost('/api/admin/get-user-plan', { userId: props.userId }),
		]);
		if (!plansResult.ok) throw new Error('プラン一覧の取得に失敗しました');
		if (!assignmentResult.ok) throw new Error('プラン割当の取得に失敗しました');
		plans.value = plansResult.data;
		userPlan.value = assignmentResult.data;
		selectedPlanId.value = assignmentResult.data?.planId ?? plansResult.data[0]?.id ?? '';
		planExpiresAt.value = assignmentResult.data ? toDatetimeLocal(assignmentResult.data.expiresAt) : '';
	} catch (e) {
		error.value = String(e);
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

function toDatetimeLocal(timestamp: number): string {
	const date = new Date(timestamp);
	const offsetMs = date.getTimezoneOffset() * 60 * 1000;
	return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getExpiresAtTimestamp(): number | null {
	if (!planExpiresAt.value) return null;
	const timestamp = new Date(planExpiresAt.value).getTime();
	return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDateTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(timestamp));
}

async function assignPlan(): Promise<void> {
	const expiresAt = getExpiresAtTimestamp();
	if (!selectedPlanId.value || expiresAt == null) {
		error.value = 'プランと失効日時を入力してください';
		return;
	}

	assigningPlan.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await apiPost('/api/admin/assign-user-plan', { userId: props.userId, planId: selectedPlanId.value, expiresAt });
		if (!result.ok) throw new Error('プラン割当に失敗しました');
		success.value = 'プランを割り当てました';
		await Promise.all([fetchQuota(), fetchPlansAndAssignment()]);
	} catch (e) {
		error.value = String(e);
	} finally {
		assigningPlan.value = false;
	}
}

async function executeRemovePlan(): Promise<void> {
	removePlanDialog.value = false;
	deletingPlan.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await apiPost('/api/admin/delete-user-plan', { userId: props.userId });
		if (!result.ok) throw new Error('プラン解除に失敗しました');
		userPlan.value = null;
		planExpiresAt.value = '';
		success.value = 'プラン割当を解除しました';
		await fetchQuota();
	} catch (e) {
		error.value = String(e);
	} finally {
		deletingPlan.value = false;
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
      <div :class="$style.userHeader">
        <div>
          <h3 :class="$style.username">{{ username || 'ユーザー' }}</h3>
          <div :class="[$style.userIdRow, 'flex', 'gap-2', 'items-center']">
            <span :class="['text-muted', $style.smallText]">ユーザーID:</span>
            <code :class="[$style.userId, 'font-mono']">{{ userId }}</code>
          </div>
        </div>
        <div :class="$style.statusBadges">
          <span v-if="activeUserPlan" class="badge badge-admin">課金プラン適用中</span>
          <span v-else-if="userPlan && !loading" class="badge badge-warning">課金プラン失効済み</span>
          <span v-if="!hasUserQuota && !loading" class="badge badge-muted">カスタムなし</span>
          <span v-if="hasUserQuota && !loading" class="badge badge-info">カスタム設定あり</span>
        </div>
      </div>

      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <div v-else :class="$style.settingsGrid">
        <div class="tab-bar" role="tablist" aria-label="ユーザークォータ設定">
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'billing' }" @click="activeTab = 'billing'">課金</button>
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'custom' }" @click="activeTab = 'custom'">カスタム</button>
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'reset' }" @click="activeTab = 'reset'">リセット</button>
        </div>

        <div v-if="activeTab === 'billing'" :class="[$style.panel, 'card']">
          <h3 :class="$style.panelTitle">課金プラン割当</h3>
          <div v-if="userPlan" :class="$style.currentPlan">
            <span :class="['badge', activeUserPlan ? 'badge-admin' : 'badge-warning']">{{ userPlan.planName }}</span>
            <span :class="['text-muted', $style.smallText]">失効: {{ formatDateTime(userPlan.expiresAt) }}</span>
          </div>
          <div v-else class="text-muted">現在のプラン割当はありません。</div>
          <div :class="$style.planControls">
            <label :class="$style.field">
              <span>プラン</span>
              <select v-model="selectedPlanId" class="form-input" :disabled="assigningPlan || plans.length === 0">
                <option v-for="plan in plans" :key="plan.id" :value="plan.id">{{ plan.name }}</option>
              </select>
            </label>
            <label :class="$style.field">
              <span>失効日時</span>
              <input v-model="planExpiresAt" class="form-input" type="datetime-local" :disabled="assigningPlan">
            </label>
            <Button.Root type="button" class="btn btn-primary" :disabled="plans.length === 0 || !selectedPlanId || !planExpiresAt" :loading="assigningPlan" @click="assignPlan">
              <Button.Loading>保存中...</Button.Loading>
              <Button.Content>割り当てる</Button.Content>
            </Button.Root>
            <Button.Root v-if="userPlan" type="button" class="btn btn-ghost-danger" :loading="deletingPlan" @click="removePlanDialog = true">
              <Button.Loading>解除中...</Button.Loading>
              <Button.Content>解除</Button.Content>
            </Button.Root>
          </div>
          <p v-if="plans.length === 0" :class="['text-muted', $style.formHint]">先に課金プラン管理でプランを作成してください。</p>
        </div>

        <div v-else-if="activeTab === 'custom'" :class="$style.tabPanel">
          <div v-if="activeUserPlan" class="alert alert-warning">
            課金プラン適用中はカスタム値を保存しても現在のクォータ判定には反映されません。プランの失効または解除後に、このカスタム値が有効になります。
          </div>
          <p :class="['text-muted', $style.formHint]">空欄は無制限。カスタム設定がない場合はグローバルデフォルトに戻ります。</p>
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

        <div v-else :class="[$style.panel, 'card']">
          <h3 :class="$style.panelTitle">リセット</h3>
          <p :class="['text-muted', $style.formHint]">
            カスタムクォータを削除してグローバルデフォルトに戻します。課金プラン割当は解除されません。
          </p>
          <div class="flex gap-2">
            <Button.Root
              v-if="hasUserQuota"
              type="button"
              class="btn btn-ghost-danger"
              :loading="deleting"
              @click="resetDialog = true"
            >
              <Button.Loading>リセット中...</Button.Loading>
              <Button.Content>カスタムクォータをリセット</Button.Content>
            </Button.Root>
            <span v-else class="text-muted">リセットできるカスタム設定はありません。</span>
          </div>
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
    <ConfirmDialog
      v-model:open="removePlanDialog"
      title="プラン割当を解除"
      message="このユーザーの課金プラン割当を解除しますか？"
      confirm-label="解除する"
      :danger="true"
      @confirm="executeRemovePlan"
      @cancel="removePlanDialog = false"
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

.userHeader {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.username {
  margin: 0 0 6px;
  font-size: 1.75rem;
  line-height: 1.2;
}

.statusBadges {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.settingsGrid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 700px;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tabPanel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panelTitle {
  margin: 0;
  font-size: 1rem;
}

.currentPlan {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.planControls {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(220px, 1fr) auto auto;
  gap: 10px;
  align-items: end;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.875rem;
  font-weight: 500;
}

.formHint {
  font-size: 0.875rem;
  margin: 0;
}

.userIdRow {
  flex-wrap: wrap;
}

@media (max-width: 760px) {
  .planControls {
    grid-template-columns: 1fr;
  }
}
</style>
