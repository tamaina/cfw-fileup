<!--
  Valibotスキーマを利用し、設定画面の項目を自動で描画します。
-->

<script setup lang="ts" generic="TValue extends string | number | null = string">
import * as v from 'valibot';
import { computed } from 'vue';

type SchemaLike = v.GenericSchema<unknown, string | number | null> & {
	type: string;
	wrapped?: unknown;
	pipe?: unknown[];
	options?: readonly string[];
};

const props = defineProps<{
	modelValue: TValue;
	schema: v.GenericSchema<unknown, TValue>;
	title: string;
	saving?: boolean;
	multiline?: boolean;
	/** selectの選択肢に表示するラベル。未指定時はvalue値をそのまま表示 */
	optionLabels?: Record<string, string>;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: TValue];
	save: [value: TValue];
}>();

type InputKind = 'checkbox' | 'select' | 'textarea' | 'text' | 'number';

function unwrapSchema(schema: unknown): SchemaLike {
	const s = schema as SchemaLike;
	if (s.type === 'optional' || s.type === 'nullable' || s.type === 'nullish') {
		return unwrapSchema(s.wrapped);
	}
	if (s.type === 'pipe') {
		return unwrapSchema(s.pipe?.[0]);
	}
	return s;
}

const innerSchema = computed<SchemaLike>(() => {
	return unwrapSchema(props.schema);
});

const inputKind = computed<InputKind>(() => {
	if (innerSchema.value.type === 'number') return 'number';
	if (innerSchema.value.type === 'picklist') {
		const opts = innerSchema.value.options ?? [];
		if (opts.length === 2 && opts[0] === 'true' && opts[1] === 'false') return 'checkbox';
		return 'select';
	}
	return props.multiline ? 'textarea' : 'text';
});

const picklistOptions = computed(() => {
	if (innerSchema.value.type !== 'picklist') return [] as readonly string[];
	return innerSchema.value.options ?? [];
});

const validationError = computed(() => {
	const result = v.safeParse(props.schema, props.modelValue);
	return result.success ? null : result.issues[0]?.message ?? '入力値が正しくありません';
});

function onCheckboxChange(e: Event) {
	const value = (e.target as HTMLInputElement).checked ? 'true' : 'false';
	emit('update:modelValue', value as TValue);
	emit('save', value as TValue);
}

function onSelectChange(e: Event) {
	const value = (e.target as HTMLSelectElement).value;
	emit('update:modelValue', value as TValue);
	emit('save', value as TValue);
}

function onTextInput(e: Event) {
	emit('update:modelValue', (e.target as HTMLInputElement | HTMLTextAreaElement).value as TValue);
}

function onNumberInput(e: Event) {
	const raw = (e.target as HTMLInputElement).value;
	const value = raw === '' ? null : Number(raw);
	if (value !== null && !Number.isFinite(value)) return;
	emit('update:modelValue', value as TValue);
}

function onSave() {
	if (validationError.value != null) return;
	emit('save', props.modelValue);
}
</script>

<template>
  <div :class="[$style.settingRow, { [$style.settingRowMultiline]: inputKind === 'textarea' }]">
    <!-- textarea -->
    <template v-if="inputKind === 'textarea'">
      <div :class="$style.textareaHeader">
        <div :class="$style.settingRowInfo">
          <label :class="[$style.label]">{{ title }}</label>
          <div v-if="$slots.default" :class="$style.description">
            <slot />
          </div>
        </div>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="saving"
          @click="onSave"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
      <textarea
        :value="(modelValue as string)"
        :class="[$style.textarea, 'form-input']"
        rows="4"
        :aria-invalid="validationError != null"
        @input="onTextInput"
      />
      <p v-if="validationError" :class="$style.validationError">{{ validationError }}</p>
    </template>

    <!-- checkbox -->
    <template v-else-if="inputKind === 'checkbox'">
      <div :class="$style.settingRowInfo">
        <label :class="[$style.label, $style.cursorPointer]">{{ title }}</label>
        <div v-if="$slots.default" :class="$style.description">
          <slot />
        </div>
      </div>
      <div :class="$style.settingRowControl">
        <input
          type="checkbox"
          :checked="modelValue === 'true'"
          :disabled="saving"
          :class="$style.checkbox"
          @change="onCheckboxChange"
        >
      </div>
    </template>

    <!-- select -->
    <template v-else-if="inputKind === 'select'">
      <div :class="$style.settingRowInfo">
        <label :class="[$style.label]">{{ title }}</label>
        <div v-if="$slots.default" :class="$style.description">
          <slot />
        </div>
      </div>
      <div :class="$style.settingRowControl">
        <select
          :value="(modelValue as string)"
          :disabled="saving"
          class="form-input"
          :class="$style.select"
          @change="onSelectChange"
        >
          <option v-for="opt in picklistOptions" :key="opt" :value="opt">{{ optionLabels?.[opt] ?? opt }}</option>
        </select>
      </div>
    </template>

    <!-- number -->
    <template v-else-if="inputKind === 'number'">
      <div :class="$style.settingRowInfo">
        <label :class="[$style.label]">{{ title }}</label>
        <div v-if="$slots.default" :class="$style.description">
          <slot />
        </div>
      </div>
      <div :class="$style.settingRowControl">
        <div class="flex gap-2">
          <input
            :value="modelValue == null ? '' : String(modelValue)"
            type="number"
            min="0"
            placeholder="無制限"
            :disabled="saving"
            :aria-invalid="validationError != null"
            :class="[$style.numberInput, 'form-input']"
            @input="onNumberInput"
          >
          <button
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
    </template>

    <!-- text -->
    <template v-else>
      <div :class="$style.settingRowInfo">
        <label :class="[$style.label]">{{ title }}</label>
        <div v-if="$slots.default" :class="$style.description">
          <slot />
        </div>
      </div>
      <div :class="$style.settingRowControl">
        <div class="flex gap-2">
          <input
            :value="(modelValue as string)"
            type="text"
            :disabled="saving"
            :aria-invalid="validationError != null"
            :class="[$style.textInput, 'form-input']"
            @input="onTextInput"
          >
          <button
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
    </template>
  </div>
</template>

<style module lang="scss">
.settingRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.settingRowMultiline {
  gap: 8px;
  align-items: flex-start;
  flex-direction: column;
}

.settingRowInfo {
  flex: 1;
  min-width: 0;
}

.settingRowControl {
  flex-shrink: 0;
}

.textareaHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.cursorPointer {
  cursor: pointer;
}

.textarea {
  width: 100%;
  resize: vertical;
  font-family: monospace;
}

.checkbox {
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: var(--color-primary);
}

.textInput {
  width: 160px;
}

.numberInput {
  width: 160px;
}

.select {
  min-width: 120px;
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
</style>
