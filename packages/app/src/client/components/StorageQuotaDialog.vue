<script setup lang="ts">
import { AlertDialog } from '@vuetify/v0';
import { formatBytes } from '@/utils/byte-size';

const props = defineProps<{
	open: boolean;
	requiredBytes: number;
	availableBytes: number;
}>();

const emit = defineEmits<{
	'update:open': [boolean];
}>();

function close(): void {
	emit('update:open', false);
}
</script>

<template>
  <AlertDialog.Root :model-value="open" @update:model-value="emit('update:open', $event)">
    <AlertDialog.Content :class="$style.dialog">
      <div :class="$style.inner">
        <AlertDialog.Title :class="$style.title">ストレージ容量が不足しています</AlertDialog.Title>
        <AlertDialog.Description :class="$style.desc">
          このブラウザの一時ストレージの空き容量が足りないため、ダウンロードを完了できません。<br>
          <br>
          必要な容量: <strong>{{ formatBytes(props.requiredBytes) }}</strong><br>
          利用可能な容量: <strong>{{ formatBytes(Math.max(0, props.availableBytes)) }}</strong><br>
          <br>
          PC または Android の Chrome をお使いいただくと、この問題を回避できるかもしれません。
        </AlertDialog.Description>
        <div :class="$style.actions">
          <AlertDialog.Action class="btn btn-primary" @click="close">
            閉じる
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
  line-height: 1.6;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
