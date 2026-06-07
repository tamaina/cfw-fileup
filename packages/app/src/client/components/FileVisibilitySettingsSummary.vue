<script setup lang="ts">
import { computed } from 'vue';
import { Download, Eye, EyeOff, Globe2, KeyRound, List, ListX, Lock } from '@lucide/vue';
import type { FileVisibility } from '../../shared/file-visibility';

const props = withDefaults(defineProps<{
	visibility: FileVisibility;
	isListed: boolean;
	passphrase?: string;
	isDownloadCountEnabled?: boolean;
	isDownloadCountVisible?: boolean;
	showDownloadCountSettings?: boolean;
}>(), {
	passphrase: '',
	isDownloadCountEnabled: false,
	isDownloadCountVisible: false,
	showDownloadCountSettings: false,
});

const visibilityLabel = computed(() => {
	if (props.visibility === 'private') return '非公開';
	if (props.visibility === 'passphrase') return props.passphrase ? '合言葉あり' : '合言葉未設定';
	return '公開';
});

const downloadCountLabel = computed(() => {
	if (!props.showDownloadCountSettings) return '';
	if (!props.isDownloadCountEnabled) return 'DL数なし';
	return props.isDownloadCountVisible ? 'DL数公開' : 'DL数非公開';
});
</script>

<template>
  <div :class="$style.root">
    <span :class="$style.item">
      <Globe2 v-if="visibility === 'public'" :size="14" :stroke-width="2" aria-hidden="true" />
      <Lock v-else-if="visibility === 'private'" :size="14" :stroke-width="2" aria-hidden="true" />
      <KeyRound v-else :size="14" :stroke-width="2" aria-hidden="true" />
      {{ visibilityLabel }}
    </span>
    <span :class="$style.item">
      <List v-if="isListed" :size="14" :stroke-width="2" aria-hidden="true" />
      <ListX v-else :size="14" :stroke-width="2" aria-hidden="true" />
      {{ isListed ? '一覧表示' : '一覧非表示' }}
    </span>
    <span v-if="showDownloadCountSettings" :class="$style.item">
      <Download :size="14" :stroke-width="2" aria-hidden="true" />
      {{ downloadCountLabel }}
      <Eye v-if="isDownloadCountEnabled && isDownloadCountVisible" :size="14" :stroke-width="2" aria-hidden="true" />
      <EyeOff v-else-if="isDownloadCountEnabled" :size="14" :stroke-width="2" aria-hidden="true" />
    </span>
  </div>
</template>

<style module lang="scss">
.root {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.item svg {
  flex: 0 0 auto;
  color: var(--color-text-muted);
}
</style>
