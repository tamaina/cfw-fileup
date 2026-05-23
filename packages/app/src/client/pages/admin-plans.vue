<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import * as v from 'valibot';
import { Button } from '@vuetify/v0';
import { authStore } from '../store/auth';
import { apiPost } from '../utils/api';
import NirA from '@/components/nira.vue';
import ConfirmDialog from '@/components/confirm-dialog.vue';

interface Plan {
	id: string;
	name: string;
	maxBuckets: number | null;
	maxBucketSizeBytes: number | null;
	maxFilesPerBucket: number | null;
	maxDailyUploads: number | null;
	createdAt: number;
	updatedAt: number;
}

type PlanForm = Pick<Plan, 'name' | 'maxBuckets' | 'maxBucketSizeBytes' | 'maxFilesPerBucket' | 'maxDailyUploads'>;

const quotaValueSchema = v.nullable(v.pipe(
	v.number(),
	v.integer('整数を入力してください'),
	v.minValue(0, '0以上の数値を入力してください'),
));
const nameSchema = v.pipe(v.string(), v.trim(), v.minLength(1, 'プラン名を入力してください'), v.maxLength(100, '100文字以内で入力してください'));

const plans = ref<Plan[]>([]);
const form = ref<PlanForm>(emptyForm());
const editingPlanId = ref<string | null>(null);
const loading = ref(true);
const saving = ref(false);
const deleting = ref(false);
const error = ref('');
const success = ref('');
const deleteDialog = ref(false);
const deleteTarget = ref<Plan | null>(null);

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
const canSave = computed(() => nameError.value == null && quotaError.value == null && !saving.value);

onMounted(fetchPlans);

function emptyForm(): PlanForm {
	return {
		name: '',
		maxBuckets: null,
		maxBucketSizeBytes: null,
		maxFilesPerBucket: null,
		maxDailyUploads: null,
	};
}

function onNumberInput(key: keyof Omit<PlanForm, 'name'>, e: Event): void {
	const raw = (e.target as HTMLInputElement).value;
	form.value[key] = raw === '' ? null : Number(raw);
}

function formatQuota(value: number | null): string {
	return value == null ? '無制限' : String(value);
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
	};
	success.value = '';
	error.value = '';
}

function resetForm(): void {
	editingPlanId.value = null;
	form.value = emptyForm();
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

function requestDelete(plan: Plan): void {
	deleteTarget.value = plan;
	deleteDialog.value = true;
}

async function executeDelete(): Promise<void> {
	if (!deleteTarget.value) return;
	const planId = deleteTarget.value.id;
	deleteDialog.value = false;
	deleteTarget.value = null;
	deleting.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await apiPost('/api/admin/delete-plan', { planId });
		if (!result.ok) throw new Error('削除に失敗しました');
		if (editingPlanId.value === planId) resetForm();
		success.value = 'プランを削除しました';
		await fetchPlans();
	} catch (e) {
		error.value = String(e);
	} finally {
		deleting.value = false;
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
          <div :class="$style.quotaGrid">
            <label :class="$style.field">
              <span>バケット数上限</span>
              <input :value="form.maxBuckets ?? ''" class="form-input" type="number" min="0" placeholder="無制限" @input="onNumberInput('maxBuckets', $event)">
            </label>
            <label :class="$style.field">
              <span>バケットサイズ上限 (bytes)</span>
              <input :value="form.maxBucketSizeBytes ?? ''" class="form-input" type="number" min="0" placeholder="無制限" @input="onNumberInput('maxBucketSizeBytes', $event)">
            </label>
            <label :class="$style.field">
              <span>バケットあたりファイル数上限</span>
              <input :value="form.maxFilesPerBucket ?? ''" class="form-input" type="number" min="0" placeholder="無制限" @input="onNumberInput('maxFilesPerBucket', $event)">
            </label>
            <label :class="$style.field">
              <span>1日あたりアップロード数上限</span>
              <input :value="form.maxDailyUploads ?? ''" class="form-input" type="number" min="0" placeholder="無制限" @input="onNumberInput('maxDailyUploads', $event)">
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
                  <th>バケット</th>
                  <th>サイズ</th>
                  <th>ファイル</th>
                  <th>日次</th>
                  <th class="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="plan in plans" :key="plan.id">
                  <td :class="$style.nameCell">{{ plan.name }}</td>
                  <td>{{ formatQuota(plan.maxBuckets) }}</td>
                  <td>{{ formatQuota(plan.maxBucketSizeBytes) }}</td>
                  <td>{{ formatQuota(plan.maxFilesPerBucket) }}</td>
                  <td>{{ formatQuota(plan.maxDailyUploads) }}</td>
                  <td class="col-actions">
                    <div class="flex gap-2">
                      <button type="button" class="btn btn-secondary" @click="startEdit(plan)">編集</button>
                      <Button.Root type="button" class="btn btn-ghost-danger" :loading="deleting" @click="requestDelete(plan)">
                        <Button.Loading>削除中...</Button.Loading>
                        <Button.Content>削除</Button.Content>
                      </Button.Root>
                    </div>
                  </td>
                </tr>
                <tr v-if="plans.length === 0">
                  <td colspan="6" class="text-muted">プランはまだありません。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

    <ConfirmDialog
      v-model:open="deleteDialog"
      title="プランを削除"
      :message="deleteTarget ? `プラン「${deleteTarget.name}」を削除しますか？割当も解除されます。` : ''"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeDelete"
      @cancel="deleteDialog = false"
    />
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
