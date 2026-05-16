<script setup lang="ts">
import { ref, computed } from 'vue';
import { Button } from '@vuetify/v0';
import { authStore, authHeaders } from '@/store/auth';
import { mainRouter } from '@/router';
import ConfirmDialog from '@/components/confirm-dialog.vue';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	token?: string;
}>();


const downloadUrl = computed(() => {
	const base = `/d/${props.bucketName}/${props.filePath}`;
	return props.token ? `${base}?token=${props.token}` : base;
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
	const res = await fetch(`/d/${props.bucketName}/${props.filePath}`, {
		method: 'DELETE',
		headers: authHeaders(),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({})) as { error?: string };
		deleteError.value = err.error ?? '削除失敗';
		return;
	}
	mainRouter.pushByPath(parentPath.value);
}
</script>

<template>
  <div>
    <div class="file-actions">
      <a :href="downloadUrl" download class="btn btn-primary">ダウンロード</a>
      <a v-if="isText" :href="downloadUrl" target="_blank" class="btn btn-secondary">ブラウザで開く</a>
      <Button.Root v-if="authStore.user" class="btn btn-ghost-danger" @click="deleteDialog = true">
        <Button.Content>削除</Button.Content>
      </Button.Root>
    </div>

    <div v-if="isImage" style="margin-top:16px">
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
