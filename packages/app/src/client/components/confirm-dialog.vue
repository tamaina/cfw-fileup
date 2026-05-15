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
    <AlertDialog.Content class="confirm-dialog">
      <div class="confirm-dialog-inner">
        <AlertDialog.Title class="confirm-dialog-title">{{ title }}</AlertDialog.Title>
        <AlertDialog.Description v-if="message" class="confirm-dialog-desc">{{ message }}</AlertDialog.Description>
        <div class="confirm-dialog-actions">
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
