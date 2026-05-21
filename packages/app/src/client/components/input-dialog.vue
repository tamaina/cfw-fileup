<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import * as v from 'valibot';
import { Dialog } from '@vuetify/v0';

const props = withDefaults(defineProps<{
	open: boolean;
	modelValue: string;
	schema: v.GenericSchema<unknown, string>;
	title: string;
	label: string;
	confirmLabel?: string;
	cancelLabel?: string;
	externalError?: string;
	autocomplete?: string;
	mono?: boolean;
}>(), {
	confirmLabel: '保存',
	cancelLabel: 'キャンセル',
	externalError: '',
	autocomplete: 'off',
	mono: false,
});

const emit = defineEmits<{
	'update:open': [boolean];
	'update:modelValue': [string];
	submit: [value: string];
	cancel: [];
}>();

const inputRef = ref<HTMLInputElement | null>(null);

const validationError = computed(() => {
	const result = v.safeParse(props.schema, props.modelValue);
	return result.success ? null : result.issues[0]?.message ?? '入力値が正しくありません';
});

const canSubmit = computed(() => validationError.value == null);

function close(): void {
	emit('update:open', false);
	emit('cancel');
}

function submit(): void {
	const result = v.safeParse(props.schema, props.modelValue);
	if (!result.success) return;
	emit('submit', result.output);
}

watch(() => props.open, async (open) => {
	if (!open) return;
	await nextTick();
	inputRef.value?.focus();
	inputRef.value?.select();
});
</script>

<template>
  <Dialog.Root :model-value="open" @update:model-value="emit('update:open', $event)">
    <Dialog.Content :class="$style.dialog">
      <form :class="$style.inner" @submit.prevent="submit">
        <div :class="$style.header">
          <Dialog.Title :class="$style.title">{{ title }}</Dialog.Title>
          <Dialog.Close class="btn btn-ghost" @click="close">✕</Dialog.Close>
        </div>
        <label :class="$style.label" for="input-dialog-field">{{ label }}</label>
        <input
          id="input-dialog-field"
          ref="inputRef"
          :value="modelValue"
          :class="[$style.input, 'form-input', mono && 'form-input-mono']"
          type="text"
          :autocomplete="autocomplete"
          :aria-invalid="validationError != null"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        >
        <p v-if="validationError" :class="$style.error">{{ validationError }}</p>
        <p v-if="externalError" :class="$style.error">{{ externalError }}</p>
        <div :class="$style.actions">
          <button type="button" class="btn btn-secondary" @click="close">{{ cancelLabel }}</button>
          <button type="submit" class="btn btn-primary" :disabled="!canSubmit">
            {{ confirmLabel }}
          </button>
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Root>
</template>

<style module lang="scss">
.dialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  width: min(420px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.inner {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
}

.label {
  font-size: 0.875rem;
  font-weight: 500;
}

.input {
  width: 100%;
}

.error {
  color: var(--color-danger);
  font-size: 0.8rem;
  margin: 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
