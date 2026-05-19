<script setup lang="ts">
import { ref, computed } from 'vue';
import { Button } from '@vuetify/v0';
import { authStore } from '@/store/auth';
import { apiPost } from '@/utils/api';
import { mainRouter } from '@/router';
import ConfirmDialog from '@/components/confirm-dialog.vue';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	fileId: string;
	bucketId: string | null;
	token?: string;
}>();


const downloadUrl = computed(() => {
	if (!props.fileId) return '';
	const base = `/d/${props.fileId}`;
	return props.token ? `${base}?token=${props.token}` : base;
});
const isGz = computed(() => {
	const lower = props.filePath.toLowerCase();
	return lower.endsWith('.gz') && !lower.endsWith('.tar.gz');
});
const decompressUrl = computed(() => {
	if (!props.fileId) return '';
	const base = `/d/${props.fileId}?decompress`;
	return props.token ? `${base}&token=${props.token}` : base;
});
const isImage = computed(() => {
	const ext = props.filePath.split('.').pop()?.toLowerCase() ?? '';
	return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext);
});
const isText = computed(() => {
	const ext = props.filePath.split('.').pop()?.toLowerCase() ?? '';
	return ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'yaml', 'yml', 'toml', 'sh', 'csv'].includes(ext);
});

const deleteError = ref('');
const deleteDialog = ref(false);

const parentPath = computed(() => {
	const parts = props.filePath.split('/');
	parts.pop();
	return parts.length === 0
		? `/v/${props.bucketName}/`
		: `/v/${props.bucketName}/${parts.join('/')}/`;
});

async function executeDelete(): Promise<void> {
	deleteDialog.value = false;
	deleteError.value = '';
	if (!props.bucketId) {
		deleteError.value = '削除できません（バケットIDが不明）';
		return;
	}
	const result = await apiPost('/api/files/delete', { bucketId: props.bucketId, path: props.filePath });
	if (!result.ok) {
		deleteError.value = result.data.error ?? '削除失敗';
		return;
	}
	mainRouter.pushByPath(parentPath.value);
}
</script>

<template>
  <div>
    <div class="file-actions">
      <a :href="downloadUrl" download class="btn btn-primary">ダウンロード</a>
      <a v-if="isGz" :href="decompressUrl" download class="btn btn-secondary">展開してダウンロード</a>
      <a v-if="isText" :href="downloadUrl" target="_blank" class="btn btn-secondary">ブラウザで開く</a>
      <Button.Root v-if="authStore.user" class="btn btn-ghost-danger" @click="deleteDialog = true">
        <Button.Content>削除</Button.Content>
      </Button.Root>
    </div>

    <div v-if="isImage" :class="$style.imagePreview">
      <img :src="downloadUrl" :alt="filePath" class="file-preview-image">
    </div>

    <div v-if="deleteError" class="alert alert-error mt-3">{{ deleteError }}</div>

    <ConfirmDialog
      v-model:open="deleteDialog"
      title="ファイルを削除"
      :message="`「${filePath}」を削除しますか？`"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeDelete"
      @cancel="deleteDialog = false"
    />
  </div>
</template>

<style module lang="scss">
.imagePreview {
  margin-top: 16px;
}
</style>
