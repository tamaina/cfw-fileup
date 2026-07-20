<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import * as v from 'valibot';
import { Button } from '@vuetify/v0';
import { authStore } from '@/store/auth';
import { apiPost, type ApiResult, type ApiSuccess } from '@/utils/api';
import NirA from '@/components/NirA.vue';
import ByteSizeSettingItem from '@/components/ByteSizeSettingItem.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import CurrentPlanCard from '@/components/CurrentPlanCard.vue';
import CryptoPaymentHistoryTable from '@/components/CryptoPaymentHistoryTable.vue';
import EffectiveQuotaDetails from '@/components/EffectiveQuotaDetails.vue';
import SettingItem from '@/components/SettingItem.vue';

const props = defineProps<{ userId: string }>();

interface QuotaForm {
	maxBuckets: number | null;
	maxBucketSizeBytes: number | null;
	maxFilesPerBucket: number | null;
	maxDailyUploads: number | null;
	canUseDownloadCount: boolean;
	showAds: boolean;
	canDisableFileAds: boolean;
}

interface UserPlanAssignment {
	userId: string;
	planId: string;
	planName: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

type EffectiveQuotaSource = 'plan' | 'custom' | 'global' | 'default';
type Payment = ApiSuccess<'/api/admin/list-crypto-payment-orders'>['data']['items'][number];

interface EffectiveQuota extends QuotaForm {
	effectiveQuotaExpiresAt: number | null;
	effectiveQuotaUpdatedAt: number | null;
	effectiveQuotaSource: EffectiveQuotaSource | null;
}

type ActiveTab = 'billing' | 'custom' | 'effective';

const quotaValueSchema = v.nullable(v.pipe(
	v.number(),
	v.integer('整数を入力してください'),
	v.minValue(0, '0以上の数値を入力してください'),
));
const booleanSettingSchema = v.picklist(['true', 'false']);

const quota = ref<QuotaForm>({ maxBuckets: null, maxBucketSizeBytes: null, maxFilesPerBucket: null, maxDailyUploads: null, canUseDownloadCount: false, showAds: true, canDisableFileAds: false });
const canUseDownloadCountSetting = computed<'true' | 'false'>({
	get: () => quota.value.canUseDownloadCount ? 'true' : 'false',
	set: value => {
		quota.value.canUseDownloadCount = value === 'true';
	},
});
const showAdsSetting = computed<'true' | 'false'>({
	get: () => quota.value.showAds ? 'true' : 'false',
	set: value => {
		quota.value.showAds = value === 'true';
	},
});
const canDisableFileAdsSetting = computed<'true' | 'false'>({
	get: () => quota.value.canDisableFileAds ? 'true' : 'false',
	set: value => {
		quota.value.canDisableFileAds = value === 'true';
	},
});
const userPlan = ref<UserPlanAssignment | null>(null);
const effectiveQuota = ref<EffectiveQuota | null>(null);
const username = ref('');
const activeTab = ref<ActiveTab>('effective');
const loading = ref(true);
const saving = ref(false);
const recalculating = ref(false);
const deleting = ref(false);
const error = ref('');
const success = ref('');
const hasUserQuota = ref(false);
const editingCustomQuota = ref(false);
const resetDialog = ref(false);
const payments = ref<Payment[]>([]);
const paymentsLoading = ref(false);
const checkingPaymentId = ref<string | null>(null);
const activeUserPlan = computed(() => userPlan.value != null && userPlan.value.expiresAt > Date.now());

onMounted(async () => {
	await Promise.all([fetchQuota(), fetchEffectiveQuota(), fetchPlansAndAssignment(), fetchUser(), fetchPayments()]);
});

async function fetchQuota(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/admin/get-user-custom-quota', { userId: props.userId });
		if (!result.ok) throw new Error('クォータの取得に失敗しました');
		hasUserQuota.value = result.data.exists;
		editingCustomQuota.value = result.data.exists;
		const userData = result.data.quota;

		quota.value = {
			maxBuckets: userData.maxBuckets ?? null,
			maxBucketSizeBytes: userData.maxBucketSizeBytes ?? null,
			maxFilesPerBucket: userData.maxFilesPerBucket ?? null,
			maxDailyUploads: userData.maxDailyUploads ?? null,
			canUseDownloadCount: userData.canUseDownloadCount ?? false,
			showAds: userData.showAds ?? true,
			canDisableFileAds: userData.canDisableFileAds ?? false,
		};
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function fetchEffectiveQuota(): Promise<void> {
	error.value = '';
	try {
		const result = await apiPost('/api/admin/get-user-effective-quota', { userId: props.userId });
		if (!result.ok) throw new Error('実効クォータの取得に失敗しました');
		effectiveQuota.value = result.data;
	} catch (e) {
		error.value = String(e);
	}
}

async function fetchUser(): Promise<void> {
	try {
		let cursor: string | null = null;
		do {
			const result: ApiResult<'/api/admin/list-users'> = await apiPost('/api/admin/list-users', { limit: 50, cursor });
			if (!result.ok) throw new Error('ユーザー情報の取得に失敗しました');
			const user = result.data.items.find((item) => item.id === props.userId);
			if (user) {
				username.value = user.username;
				return;
			}
			cursor = result.data.nextCursor;
		} while (cursor);
		username.value = '';
	} catch (e) {
		error.value = String(e);
	}
}

async function fetchPlansAndAssignment(): Promise<void> {
	try {
		const assignmentResult = await apiPost('/api/admin/get-user-plan', { userId: props.userId });
		if (!assignmentResult.ok) throw new Error('プラン割当の取得に失敗しました');
		userPlan.value = assignmentResult.data;
	} catch (e) {
		error.value = String(e);
	}
}

async function fetchPayments(): Promise<void> {
	paymentsLoading.value = true;
	try {
		const result = await apiPost('/api/admin/list-crypto-payment-orders', { userId: props.userId, limit: 20, cursor: null });
		if (!result.ok) throw new Error('決済履歴の取得に失敗しました');
		payments.value = result.data.items;
	} catch (e) {
		error.value = String(e);
	} finally {
		paymentsLoading.value = false;
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
		editingCustomQuota.value = true;
		success.value = 'ユーザークォータを保存しました';
		await fetchEffectiveQuota();
	} catch (e) {
		error.value = String(e);
	} finally {
		saving.value = false;
	}
}

function formatDateTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(timestamp));
}

async function checkPayment(payment: Payment): Promise<void> {
	checkingPaymentId.value = payment.id;
	error.value = '';
	success.value = '';
	try {
		const result = await apiPost('/api/admin/check-crypto-payment-order', { orderId: payment.id });
		if (!result.ok) throw new Error(result.data.message || '決済の再確認に失敗しました');
		success.value = result.data.status === 'paid' ? '決済を確認しました' : '決済を再確認しました';
		await Promise.all([fetchPayments(), fetchPlansAndAssignment(), fetchEffectiveQuota()]);
	} catch (e) {
		error.value = String(e);
	} finally {
		checkingPaymentId.value = null;
	}
}

function startCustomQuota(): void {
	const sourceQuota = effectiveQuota.value ?? quota.value;
	quota.value = {
		maxBuckets: sourceQuota.maxBuckets,
		maxBucketSizeBytes: sourceQuota.maxBucketSizeBytes,
		maxFilesPerBucket: sourceQuota.maxFilesPerBucket,
		maxDailyUploads: sourceQuota.maxDailyUploads,
		canUseDownloadCount: sourceQuota.canUseDownloadCount,
		showAds: sourceQuota.showAds,
		canDisableFileAds: sourceQuota.canDisableFileAds,
	};
	editingCustomQuota.value = true;
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
		editingCustomQuota.value = false;
		success.value = 'クォータをリセットしました（グローバルデフォルト適用中）';
		await Promise.all([fetchQuota(), fetchEffectiveQuota()]);
	} catch (e) {
		error.value = String(e);
	} finally {
		deleting.value = false;
	}
}

async function recalculateEffectiveQuota(): Promise<void> {
	recalculating.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await apiPost('/api/admin/recalculate-user-effective-quota', { userId: props.userId });
		if (!result.ok) throw new Error('実効クォータの再計算に失敗しました');
		effectiveQuota.value = result.data;
		success.value = '実効クォータを再計算しました';
	} catch (e) {
		error.value = String(e);
	} finally {
		recalculating.value = false;
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
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'effective' }" @click="activeTab = 'effective'">実効</button>
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'billing' }" @click="activeTab = 'billing'">課金</button>
          <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'custom' }" @click="activeTab = 'custom'">カスタム</button>
        </div>

        <div v-if="activeTab === 'billing'" :class="[$style.panel, 'card']">
          <h3 :class="$style.panelTitle">課金プラン</h3>
          <div v-if="userPlan" :class="$style.currentPlan">
            <span :class="['badge', activeUserPlan ? 'badge-admin' : 'badge-warning']">{{ userPlan.planName }}</span>
            <span :class="['text-muted', $style.smallText]">失効: {{ formatDateTime(userPlan.expiresAt) }}</span>
          </div>
          <div v-else class="text-muted">現在のプラン割当はありません。</div>
          <p :class="['text-muted', $style.formHint]">課金プランは支払い処理によってのみ付与されます。管理者がユーザーの容量や上限を変更する場合はカスタムクォータを使用してください。</p>
          <div :class="$style.paymentHistoryHeader">
            <h4 :class="$style.paymentHistoryTitle">決済履歴</h4>
            <Button.Root type="button" class="btn btn-secondary btn-sm" :loading="paymentsLoading" @click="fetchPayments">
              <Button.Loading>更新中...</Button.Loading>
              <Button.Content>更新</Button.Content>
            </Button.Root>
          </div>
          <CryptoPaymentHistoryTable
            :payments="payments"
            :loading="paymentsLoading"
            :checking-payment-id="checkingPaymentId"
            check-label="再確認"
            @check="checkPayment"
          />
        </div>

        <div v-else-if="activeTab === 'custom'" :class="$style.tabPanel">
          <div v-if="activeUserPlan" class="alert alert-info">
            カスタムクォータは課金プランより優先されます。保存すると即座にクォータ判定に反映され、プランの制限値は上書きされます。
          </div>
          <div v-if="!editingCustomQuota" :class="[$style.panel, 'card']">
            <h3 :class="$style.panelTitle">カスタムクォータ未設定</h3>
            <p :class="['text-muted', $style.formHint]">
              設定開始時に現在の実効クォータをフォームへ入れます。必要な値だけ変更して保存してください。
            </p>
            <div :class="$style.actionsStart">
              <Button.Root type="button" class="btn btn-primary" @click="startCustomQuota">
                <Button.Content>カスタム設定を開始</Button.Content>
              </Button.Root>
            </div>
          </div>
          <template v-else>
            <p :class="['text-muted', $style.formHint]">空欄は無制限。カスタム設定がない場合はグローバルデフォルトに戻ります。</p>
            <SettingItem
              v-model="quota.maxBuckets"
              :schema="quotaValueSchema"
              title="バケット数上限"
              :saving="saving"
              :show-save-button="false"
              :save-on-change="false"
            />
            <ByteSizeSettingItem
              v-model="quota.maxBucketSizeBytes"
              :schema="quotaValueSchema"
              title="バケットサイズ上限"
              :saving="saving"
              :show-save-button="false"
            />
            <SettingItem
              v-model="quota.maxFilesPerBucket"
              :schema="quotaValueSchema"
              title="バケットあたりファイル数上限"
              :saving="saving"
              :show-save-button="false"
              :save-on-change="false"
            />
            <SettingItem
              v-model="quota.maxDailyUploads"
              :schema="quotaValueSchema"
              title="1日あたりアップロード数上限"
              :saving="saving"
              :show-save-button="false"
              :save-on-change="false"
            />
            <SettingItem
              v-model="canUseDownloadCountSetting"
              :schema="booleanSettingSchema"
              title="DL数カウントを許可"
              :saving="saving"
              :show-save-button="false"
              :save-on-change="false"
            />
            <SettingItem
              v-model="showAdsSetting"
              :schema="booleanSettingSchema"
              title="閲覧時に広告を表示"
              :saving="saving"
              :show-save-button="false"
              :save-on-change="false"
            />
            <SettingItem
              v-model="canDisableFileAdsSetting"
              :schema="booleanSettingSchema"
              title="配信ファイルの広告オフを許可"
              :saving="saving"
              :show-save-button="false"
              :save-on-change="false"
            />
            <div :class="$style.actions">
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
              <Button.Root type="button" class="btn btn-primary" :loading="saving" @click="saveQuota">
                <Button.Loading>保存中...</Button.Loading>
                <Button.Content>保存</Button.Content>
              </Button.Root>
            </div>
          </template>
        </div>

        <div v-else-if="activeTab === 'effective'" :class="$style.tabPanel">
          <div :class="[$style.panel, 'card']">
            <EffectiveQuotaDetails :quota="effectiveQuota">
              <template #actions>
                <Button.Root type="button" class="btn btn-secondary" :loading="recalculating" @click="recalculateEffectiveQuota">
                  <Button.Loading>再計算中...</Button.Loading>
                  <Button.Content>再計算</Button.Content>
                </Button.Root>
              </template>
            </EffectiveQuotaDetails>
          </div>
          <CurrentPlanCard :plan="userPlan" />
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
  max-width: 960px;
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

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.actionsStart {
  display: flex;
  justify-content: flex-start;
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

.formHint {
  font-size: 0.875rem;
  margin: 0;
}

.paymentHistoryHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
}

.paymentHistoryTitle {
  margin: 0;
  font-size: 1rem;
}

.userIdRow {
  flex-wrap: wrap;
}

</style>
