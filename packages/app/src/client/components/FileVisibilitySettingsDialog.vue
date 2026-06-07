<script setup lang="ts">
import { ref, watch } from 'vue';
import { Dialog } from '@vuetify/v0';
import type { FileVisibility } from '../../shared/file-visibility';
import FileVisibilitySettings from './FileVisibilitySettings.vue';

const props = withDefaults(defineProps<{
	open: boolean;
	visibility: FileVisibility;
	isListed: boolean;
	passphrase?: string;
	isDownloadCountEnabled?: boolean;
	isDownloadCountVisible?: boolean;
	canUseDownloadCount?: boolean;
	showDownloadCountSettings?: boolean;
	downloadCount?: number | null;
	lockVisibility?: boolean;
	passphraseAutocomplete?: string;
}>(), {
	passphrase: '',
	isDownloadCountEnabled: false,
	isDownloadCountVisible: false,
	canUseDownloadCount: false,
	showDownloadCountSettings: false,
	downloadCount: null,
	lockVisibility: false,
	passphraseAutocomplete: undefined,
});

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'update:visibility', value: FileVisibility): void;
	(e: 'update:isListed', value: boolean): void;
	(e: 'update:passphrase', value: string): void;
	(e: 'update:isDownloadCountEnabled', value: boolean): void;
	(e: 'update:isDownloadCountVisible', value: boolean): void;
}>();

interface VisibilityDraft {
	visibility: FileVisibility;
	isListed: boolean;
	passphrase: string;
	isDownloadCountEnabled: boolean;
	isDownloadCountVisible: boolean;
}

const draft = ref<VisibilityDraft>(createDraft());
const openedDraft = ref<VisibilityDraft>(createDraft());

watch(() => props.open, (open) => {
	if (open) {
		draft.value = createDraft();
		openedDraft.value = createDraft();
	}
});

watch([
	() => props.visibility,
	() => props.isListed,
	() => props.passphrase,
	() => props.isDownloadCountEnabled,
	() => props.isDownloadCountVisible,
], () => {
	if (!props.open) {
		draft.value = createDraft();
		openedDraft.value = createDraft();
	}
});

function createDraft(): VisibilityDraft {
	return {
		visibility: props.visibility,
		isListed: props.isListed,
		passphrase: props.passphrase,
		isDownloadCountEnabled: props.isDownloadCountEnabled,
		isDownloadCountVisible: props.isDownloadCountVisible,
	};
}

function updateOpen(value: boolean): void {
	if (value) {
		emit('update:open', true);
		return;
	}
	close();
}

function close(): void {
	emit('update:visibility', draft.value.visibility);
	emit('update:isListed', draft.value.isListed);
	emit('update:passphrase', draft.value.passphrase);
	emit('update:isDownloadCountEnabled', draft.value.isDownloadCountEnabled);
	emit('update:isDownloadCountVisible', draft.value.isDownloadCountVisible);
	emit('update:open', false);
}

function restoreOpenedSettings(): void {
	draft.value = { ...openedDraft.value };
}
</script>

<template>
  <Dialog.Root :model-value="open" @update:model-value="updateOpen">
    <Dialog.Content :class="$style.dialog">
      <div :class="$style.inner">
        <div :class="$style.header">
          <Dialog.Title :class="$style.title">公開設定</Dialog.Title>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="閉じる" @click="close">✕</button>
        </div>

        <FileVisibilitySettings
          v-model:visibility="draft.visibility"
          v-model:is-listed="draft.isListed"
          v-model:passphrase="draft.passphrase"
          v-model:is-download-count-enabled="draft.isDownloadCountEnabled"
          v-model:is-download-count-visible="draft.isDownloadCountVisible"
          :can-use-download-count="canUseDownloadCount"
          :show-download-count-settings="showDownloadCountSettings"
          :download-count="downloadCount"
          :lock-visibility="lockVisibility"
          :passphrase-autocomplete="passphraseAutocomplete"
        />

        <div :class="$style.actions">
          <button type="button" class="btn btn-secondary" @click="restoreOpenedSettings">戻す</button>
          <button type="button" class="btn btn-primary" @click="close">閉じる</button>
        </div>
      </div>
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
  width: min(520px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.inner {
  display: grid;
  gap: 18px;
  padding: 24px;
}

.header,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
}

.actions {
  justify-content: flex-end;
}
</style>
