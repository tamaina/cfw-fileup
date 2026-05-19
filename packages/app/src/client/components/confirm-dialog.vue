<script setup lang="ts">
import { AlertDialog } from '@vuetify/v0';

const props = defineProps<{
	open: boolean;
	title: string;
	message?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
}>();

const emit = defineEmits<{
	'update:open': [boolean];
	confirm: [];
	cancel: [];
}>();

function handleConfirm(): void {
	emit('update:open', false);
	emit('confirm');
}

function handleCancel(): void {
	emit('update:open', false);
	emit('cancel');
}
</script>

<template>
  <AlertDialog.Root :model-value="open" @update:model-value="emit('update:open', $event)">
    <AlertDialog.Content :class="$style.dialog">
      <div :class="$style.inner">
        <AlertDialog.Title :class="$style.title">{{ title }}</AlertDialog.Title>
        <AlertDialog.Description v-if="message" :class="$style.desc">{{ message }}</AlertDialog.Description>
        <div :class="$style.actions">
          <AlertDialog.Cancel class="btn btn-secondary" @click="handleCancel">
            {{ cancelLabel ?? 'キャンセル' }}
          </AlertDialog.Cancel>
          <AlertDialog.Action
            :class="['btn', danger ? 'btn-danger' : 'btn-primary']"
            @click="handleConfirm"
          >
            {{ confirmLabel ?? '確認' }}
          </AlertDialog.Action>
        </div>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Root>
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
}

.title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 8px;
}

.desc {
  font-size: 0.875rem;
  color: var(--color-text-muted);
  margin: 0 0 20px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
