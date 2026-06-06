<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import * as v from 'valibot';
import { BYTE_SIZE_UNITS, byteSizeUnitMultiplier, formatBytes, pickByteSizeUnit, type ByteSizeUnit } from '@/utils/byte-size';

const props = defineProps<{
	modelValue: number | null;
	schema: v.GenericSchema<unknown, number | null>;
	title: string;
	saving?: boolean;
	showSaveButton?: boolean;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: number | null];
	save: [value: number | null];
}>();

const amount = ref<number | null>(null);
const unit = ref<ByteSizeUnit>(pickByteSizeUnit(props.modelValue));
const draftValue = computed(() => {
	if (amount.value == null) return null;
	const value = amount.value * byteSizeUnitMultiplier(unit.value);
	return Number.isFinite(value) ? value : null;
});

const validationError = computed(() => {
	const result = v.safeParse(props.schema, draftValue.value);
	return result.success ? null : result.issues[0]?.message ?? '入力値が正しくありません';
});

const preview = computed(() => {
	if (props.modelValue == null) return '無制限';
	return `${props.modelValue.toLocaleString()} bytes (${formatBytes(props.modelValue)})`;
});
const showSaveButton = computed(() => props.showSaveButton ?? true);

watch(() => props.modelValue, (value) => {
	unit.value = pickByteSizeUnit(value);
	amount.value = value == null ? null : value / byteSizeUnitMultiplier(unit.value);
}, { immediate: true });

function updateValue(): void {
	if (validationError.value != null) return;
	emit('update:modelValue', draftValue.value);
}

function onAmountInput(e: Event): void {
	const raw = (e.target as HTMLInputElement).value;
	amount.value = raw === '' ? null : Number(raw);
	updateValue();
}

function onUnitChange(e: Event): void {
	unit.value = (e.target as HTMLSelectElement).value as ByteSizeUnit;
	updateValue();
}

function onSave(): void {
	if (validationError.value != null) return;
	emit('save', draftValue.value);
}
</script>

<template>
  <div :class="$style.settingRow">
    <div :class="$style.settingRowInfo">
      <label :class="$style.label">{{ title }}</label>
      <div :class="$style.description">{{ preview }}</div>
      <div v-if="$slots.default" :class="$style.description">
        <slot />
      </div>
    </div>
    <div :class="$style.settingRowControl">
      <div :class="$style.controlRow">
        <input
          :value="amount == null ? '' : String(amount)"
          type="number"
          min="0"
          step="any"
          placeholder="無制限"
          :disabled="saving"
          :aria-invalid="validationError != null"
          :class="[$style.amountInput, 'form-input']"
          @input="onAmountInput"
        >
        <select
          :value="unit"
          :disabled="saving"
          :class="[$style.unitSelect, 'form-input']"
          @change="onUnitChange"
        >
          <option v-for="sizeUnit in BYTE_SIZE_UNITS" :key="sizeUnit" :value="sizeUnit">{{ sizeUnit }}</option>
        </select>
        <button
          v-if="showSaveButton"
          type="button"
          class="btn btn-primary"
          :disabled="saving || validationError != null"
          @click="onSave"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
      <p v-if="validationError" :class="$style.validationError">{{ validationError }}</p>
    </div>
  </div>
</template>

<style module lang="scss">
.settingRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.settingRowInfo {
  flex: 1;
  min-width: 0;
}

.settingRowControl {
  flex-shrink: 0;
}

.controlRow {
  display: flex;
  gap: 8px;
}

.amountInput {
  width: 120px;
}

.unitSelect {
  width: 88px;
}

.label {
  font-weight: 500;
  font-size: 0.875rem;
}

.description {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.validationError {
  margin: 4px 0 0;
  color: var(--color-danger);
  font-size: 0.8125rem;
}

@media (max-width: 640px) {
  .settingRow {
    align-items: stretch;
    flex-direction: column;
  }

  .settingRowControl {
    width: 100%;
  }

  .controlRow {
    flex-wrap: wrap;
  }

  .amountInput {
    flex: 1 1 140px;
  }
}
</style>
