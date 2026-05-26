<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import * as v from 'valibot';
import { Button } from '@vuetify/v0';
import { authStore } from '@/store/auth';
import { apiPost } from '@/utils/api';
import NirA from '@/components/NirA.vue';
import { BYTE_SIZE_UNITS, byteSizeUnitMultiplier, formatBytes, pickByteSizeUnit, type ByteSizeUnit } from '@/utils/byte-size';

interface Plan {
	id: string;
	name: string;
	maxBuckets: number | null;
	maxBucketSizeBytes: number | null;
	maxFilesPerBucket: number | null;
	maxDailyUploads: number | null;
	canUseDownloadCount: boolean;
	isEnabled: boolean;
	sortOrder: number;
	createdAt: number;
	updatedAt: number;
}

type PlanForm = Pick<Plan, 'name' | 'maxBuckets' | 'maxBucketSizeBytes' | 'maxFilesPerBucket' | 'maxDailyUploads' | 'canUseDownloadCount' | 'isEnabled' | 'sortOrder'>;
type NullableNumberPlanFormKey = 'maxBuckets' | 'maxBucketSizeBytes' | 'maxFilesPerBucket' | 'maxDailyUploads';

const quotaValueSchema = v.nullable(v.pipe(
	v.number(),
	v.integer('整数を入力してください'),
	v.minValue(0, '0以上の数値を入力してください'),
));
const nameSchema = v.pipe(v.string(), v.trim(), v.minLength(1, 'プラン名を入力してください'), v.maxLength(100, '100文字以内で入力してください'));
const sortOrderSchema = v.pipe(v.number(), v.integer('整数を入力してください'));

const plans = ref<Plan[]>([]);
const form = ref<PlanForm>(emptyForm());
const bucketSizeAmount = ref<number | null>(null);
const bucketSizeUnit = ref<ByteSizeUnit>('MiB');
const editingPlanId = ref<string | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const success = ref('');

const isEditing = computed(() => editingPlanId.value != null);
const nameError = computed(() => {
	const result = v.safeParse(nameSchema, form.value.name);
	return result.success ? null : result.issues[0]?.message ?? '入力値が正しくありません';
});
const quotaError = computed(() => {
	const values = [
		form.value.maxBuckets,
		form.value.maxBucketSizeBytes,
		form.value.maxFilesPerBucket,
		form.value.maxDailyUploads,
	];
	for (const value of values) {
		const result = v.safeParse(quotaValueSchema, value);
		if (!result.success) return result.issues[0]?.message ?? '入力値が正しくありません';
	}
	return null;
});
const sortOrderError = computed(() => {
	const result = v.safeParse(sortOrderSchema, form.value.sortOrder);
	return result.success ? null : result.issues[0]?.message ?? '入力値が正しくありません';
});
const canSave = computed(() => nameError.value == null && quotaError.value == null && sortOrderError.value == null && !saving.value);

onMounted(fetchPlans);

function emptyForm(): PlanForm {
	return {
		name: '',
		maxBuckets: null,
		maxBucketSizeBytes: null,
		maxFilesPerBucket: null,
		maxDailyUploads: null,
		canUseDownloadCount: false,
		isEnabled: true,
		sortOrder: 0,
	};
}

function onNumberInput(key: NullableNumberPlanFormKey, e: Event): void {
	const raw = (e.target as HTMLInputElement).value;
	form.value[key] = raw === '' ? null : Number(raw);
}

function onSortOrderInput(e: Event): void {
	const raw = (e.target as HTMLInputElement).value;
	form.value.sortOrder = raw === '' ? Number.NaN : Number(raw);
}

function syncBucketSizeInput(value: number | null): void {
	bucketSizeUnit.value = pickByteSizeUnit(value);
	bucketSizeAmount.value = value == null ? null : value / byteSizeUnitMultiplier(bucketSizeUnit.value);
}

function updateBucketSizeBytes(): void {
	if (bucketSizeAmount.value == null) {
		form.value.maxBucketSizeBytes = null;
		return;
	}
	const bytes = bucketSizeAmount.value * byteSizeUnitMultiplier(bucketSizeUnit.value);
	if (!Number.isFinite(bytes)) return;
	form.value.maxBucketSizeBytes = bytes;
}

function onBucketSizeAmountInput(e: Event): void {
	const raw = (e.target as HTMLInputElement).value;
	bucketSizeAmount.value = raw === '' ? null : Number(raw);
	updateBucketSizeBytes();
}

function onBucketSizeUnitChange(e: Event): void {
	bucketSizeUnit.value = (e.target as HTMLSelectElement).value as ByteSizeUnit;
	updateBucketSizeBytes();
}

function formatQuota(value: number | null, formatter: (value: number) => string = String): string {
	return value == null ? '無制限' : formatter(value);
}

function formatBucketSizePreview(value: number | null): string {
	return value == null ? '無制限' : `${value.toLocaleString()} bytes (${formatBytes(value)})`;
}

async function fetchPlans(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/admin/list-plans');
		if (!result.ok) throw new Error('プラン一覧の取得に失敗しました');
		plans.value = result.data;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

function startEdit(plan: Plan): void {
	editingPlanId.value = plan.id;
	form.value = {
		name: plan.name,
		maxBuckets: plan.maxBuckets,
		maxBucketSizeBytes: plan.maxBucketSizeBytes,
		maxFilesPerBucket: plan.maxFilesPerBucket,
		maxDailyUploads: plan.maxDailyUploads,
		canUseDownloadCount: plan.canUseDownloadCount,
		isEnabled: plan.isEnabled,
		sortOrder: plan.sortOrder,
	};
	syncBucketSizeInput(plan.maxBucketSizeBytes);
	success.value = '';
	error.value = '';
}

function resetForm(): void {
	editingPlanId.value = null;
	form.value = emptyForm();
	syncBucketSizeInput(null);
}

async function savePlan(): Promise<void> {
	if (!canSave.value) return;
	saving.value = true;
	error.value = '';
	success.value = '';
	try {
		const body = { ...form.value };
		const result = editingPlanId.value
			? await apiPost('/api/admin/update-plan', { planId: editingPlanId.value, ...body })
			: await apiPost('/api/admin/create-plan', body);
		if (!result.ok) throw new Error('保存に失敗しました');
		success.value = editingPlanId.value ? 'プランを更新しました' : 'プランを作成しました';
		resetForm();
		await fetchPlans();
	} catch (e) {
		error.value = String(e);
	} finally {
		saving.value = false;
	}
}

async function togglePlanEnabled(plan: Plan): Promise<void> {
	saving.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await apiPost('/api/admin/update-plan', {
			planId: plan.id,
			name: plan.name,
			maxBuckets: plan.maxBuckets,
			maxBucketSizeBytes: plan.maxBucketSizeBytes,
			maxFilesPerBucket: plan.maxFilesPerBucket,
			maxDailyUploads: plan.maxDailyUploads,
			canUseDownloadCount: plan.canUseDownloadCount,
			isEnabled: !plan.isEnabled,
			sortOrder: plan.sortOrder,
		});
		if (!result.ok) throw new Error('保存に失敗しました');
		success.value = plan.isEnabled ? 'プランを無効化しました' : 'プランを有効化しました';
		await fetchPlans();
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
      <h2 class="section-title">課金プラン管理</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>

      <div :class="$style.layout">
        <form :class="[$style.formPanel, 'card']" @submit.prevent="savePlan">
          <h3 :class="$style.panelTitle">{{ isEditing ? 'プラン編集' : 'プラン作成' }}</h3>
          <label :class="$style.field">
            <span>プラン名</span>
            <input v-model="form.name" class="form-input" type="text" maxlength="100">
            <span v-if="nameError" :class="$style.validationError">{{ nameError }}</span>
          </label>
          <label :class="$style.field">
            <span>並び順</span>
            <input :value="Number.isNaN(form.sortOrder) ? '' : form.sortOrder" class="form-input" type="number" step="1" @input="onSortOrderInput">
            <span v-if="sortOrderError" :class="$style.validationError">{{ sortOrderError }}</span>
          </label>
          <div :class="$style.quotaGrid">
            <label :class="$style.field">
              <span>バケット数上限</span>
              <input :value="form.maxBuckets ?? ''" class="form-input" type="number" min="0" placeholder="無制限" @input="onNumberInput('maxBuckets', $event)">
            </label>
            <label :class="$style.field">
              <span>バケットサイズ上限</span>
              <div :class="$style.byteSizeControls">
                <input :value="bucketSizeAmount ?? ''" class="form-input" type="number" min="0" step="any" placeholder="無制限" @input="onBucketSizeAmountInput">
                <select :value="bucketSizeUnit" class="form-input" :class="$style.byteSizeUnit" @change="onBucketSizeUnitChange">
                  <option v-for="sizeUnit in BYTE_SIZE_UNITS" :key="sizeUnit" :value="sizeUnit">{{ sizeUnit }}</option>
                </select>
              </div>
              <span :class="$style.fieldHint">{{ formatBucketSizePreview(form.maxBucketSizeBytes) }}</span>
            </label>
            <label :class="$style.field">
              <span>バケットあたりファイル数上限</span>
              <input :value="form.maxFilesPerBucket ?? ''" class="form-input" type="number" min="0" placeholder="無制限" @input="onNumberInput('maxFilesPerBucket', $event)">
            </label>
            <label :class="$style.field">
              <span>1日あたりアップロード数上限</span>
              <input :value="form.maxDailyUploads ?? ''" class="form-input" type="number" min="0" placeholder="無制限" @input="onNumberInput('maxDailyUploads', $event)">
            </label>
            <label :class="$style.checkboxField">
              <input v-model="form.canUseDownloadCount" type="checkbox">
              <span>DL数カウントを許可</span>
            </label>
            <label :class="$style.checkboxField">
              <input v-model="form.isEnabled" type="checkbox">
              <span>有効</span>
            </label>
          </div>
          <p v-if="quotaError" :class="$style.validationError">{{ quotaError }}</p>
          <div class="flex gap-2">
            <Button.Root type="button" class="btn btn-primary" :disabled="!canSave" :loading="saving" @click="savePlan">
              <Button.Loading>保存中...</Button.Loading>
              <Button.Content>{{ isEditing ? '更新' : '作成' }}</Button.Content>
            </Button.Root>
            <button v-if="isEditing" type="button" class="btn btn-secondary" @click="resetForm">キャンセル</button>
          </div>
        </form>

        <div v-if="loading" class="page-loading">
          <span class="spinner" />読み込み中...
        </div>
        <div v-else :class="[$style.tableCard, 'card']">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>プラン名</th>
                  <th>並び順</th>
                  <th>バケット</th>
                  <th>サイズ</th>
                  <th>ファイル</th>
                  <th>日次</th>
                  <th>DL数</th>
                  <th>状態</th>
                  <th class="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="plan in plans" :key="plan.id">
                  <td :class="$style.nameCell">{{ plan.name }}</td>
                  <td>{{ plan.sortOrder }}</td>
                  <td>{{ formatQuota(plan.maxBuckets) }}</td>
                  <td>{{ formatQuota(plan.maxBucketSizeBytes, formatBytes) }}</td>
                  <td>{{ formatQuota(plan.maxFilesPerBucket) }}</td>
                  <td>{{ formatQuota(plan.maxDailyUploads) }}</td>
                  <td>
                    <span :class="plan.canUseDownloadCount ? 'badge badge-success' : 'badge badge-muted'">
                      {{ plan.canUseDownloadCount ? '許可' : '不可' }}
                    </span>
                  </td>
                  <td>
                    <span :class="plan.isEnabled ? 'badge badge-success' : 'badge badge-muted'">
                      {{ plan.isEnabled ? '有効' : '無効' }}
                    </span>
                  </td>
                  <td class="col-actions">
                    <div class="flex gap-2">
                      <button type="button" class="btn btn-secondary" @click="startEdit(plan)">編集</button>
                      <button type="button" class="btn btn-secondary" :disabled="saving" @click="togglePlanEnabled(plan)">
                        {{ plan.isEnabled ? '無効化' : '有効化' }}
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="plans.length === 0">
                  <td colspan="9" class="text-muted">プランはまだありません。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

  </div>
</template>

<style module lang="scss">
.layout {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.formPanel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 760px;
}

.panelTitle {
  margin: 0;
  font-size: 1rem;
}

.quotaGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.875rem;
  font-weight: 500;
}

.checkboxField {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  font-weight: 500;
}

.byteSizeControls {
  display: flex;
  gap: 8px;
}

.byteSizeUnit {
  width: 88px;
}

.fieldHint {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  font-weight: 400;
}

.validationError {
  margin: 0;
  color: var(--color-danger);
  font-size: 0.8125rem;
}

.tableCard {
  padding: 0;
  overflow: hidden;
}

.nameCell {
  font-weight: 500;
}
</style>
