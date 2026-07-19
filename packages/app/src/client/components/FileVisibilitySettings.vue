<script setup lang="ts">
import type { FileVisibility } from '../../shared/file-visibility';

withDefaults(defineProps<{
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
	(e: 'update:visibility', value: FileVisibility): void;
	(e: 'update:isListed', value: boolean): void;
	(e: 'update:passphrase', value: string): void;
	(e: 'update:isDownloadCountEnabled', value: boolean): void;
	(e: 'update:isDownloadCountVisible', value: boolean): void;
}>();

function onVisibilityInput(event: Event): void {
	const visibility = (event.target as HTMLInputElement).value as FileVisibility;
	emit('update:visibility', visibility);
	if (visibility !== 'public') emit('update:isListed', false);
}

function onIsListedInput(event: Event): void {
	emit('update:isListed', (event.target as HTMLInputElement).checked);
}

function onPassphraseInput(event: Event): void {
	emit('update:passphrase', (event.target as HTMLInputElement).value);
}

function onDownloadCountEnabledInput(event: Event): void {
	const enabled = (event.target as HTMLInputElement).checked;
	emit('update:isDownloadCountEnabled', enabled);
	if (!enabled) emit('update:isDownloadCountVisible', false);
}

function onDownloadCountVisibleInput(event: Event): void {
	emit('update:isDownloadCountVisible', (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <div :class="$style.root">
    <div v-if="lockVisibility" class="form-hint">
      公開ファイルは非公開に戻せません。
    </div>
    <div v-else :class="$style.visibilityOptions">
      <div :class="$style.visibilitySelectGroup">
        <label class="form-label" for="file-visibility-select">公開設定</label>
        <select
          id="file-visibility-select"
          class="form-input"
          :class="$style.visibilitySelect"
          :value="visibility"
          @change="onVisibilityInput"
        >
          <option value="public">公開</option>
          <option value="private">非公開</option>
          <option value="passphrase">合言葉で保護</option>
        </select>
      </div>
      <div v-if="visibility === 'public'" class="form-hint">
        一度公開したファイルは非公開に戻せません。
      </div>
      <div v-else-if="visibility === 'private'" class="form-hint">
        一時トークンを発行し、URLを共有すればファイルにアクセスできます。
      </div>
    </div>

    <div v-if="visibility === 'passphrase' && !lockVisibility" :class="[$style.passphraseGroup, 'form-group']">
      <label class="form-label" for="file-visibility-passphrase">合言葉</label>
      <input
        id="file-visibility-passphrase"
        :value="passphrase"
        class="form-input"
        type="text"
        :autocomplete="passphraseAutocomplete"
        placeholder="アクセス用の合言葉"
        @input="onPassphraseInput"
      >
    </div>

    <label class="checkbox-label" :class="visibility !== 'public' && $style.disabledOption">
      <input
        type="checkbox"
        :checked="visibility === 'public' ? isListed : false"
        :disabled="visibility !== 'public'"
        @input="onIsListedInput"
      >
      ファイル一覧とActivityPubに表示
    </label>

    <div v-if="showDownloadCountSettings" :class="$style.downloadCountSettings">
      <div :class="$style.groupTitleRow">
        <div :class="$style.groupTitle">DL数</div>
        <span v-if="downloadCount != null" class="badge badge-info">
          {{ downloadCount.toLocaleString() }} 回
        </span>
      </div>
      <label class="checkbox-label">
        <input
          type="checkbox"
          :checked="isDownloadCountEnabled"
          :disabled="!canUseDownloadCount && !isDownloadCountEnabled"
          @input="onDownloadCountEnabledInput"
        >
        DL数をカウント
      </label>
      <label class="checkbox-label" :class="!isDownloadCountEnabled && $style.disabledOption">
        <input
          type="checkbox"
          :checked="isDownloadCountVisible"
          :disabled="!isDownloadCountEnabled"
          @input="onDownloadCountVisibleInput"
        >
        DL数を公開表示
      </label>
      <div v-if="!canUseDownloadCount && !isDownloadCountEnabled" class="form-hint">
        現在のクォータではDL数カウントを有効化できません。
      </div>
    </div>
  </div>
</template>

<style module lang="scss">
.root {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.visibilityOptions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.visibilitySelectGroup {
  max-width: 320px;
}

.visibilitySelect {
  width: 100%;
}

.passphraseGroup {
  max-width: 320px;
}

.downloadCountSettings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
}

.groupTitle {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  font-weight: 600;
}

.groupTitleRow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.disabledOption {
  color: var(--color-text-muted);
}
</style>
