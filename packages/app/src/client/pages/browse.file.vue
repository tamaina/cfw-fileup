<script setup lang="ts">
import { ref, computed } from 'vue';
import { authStore, authHeaders } from '@/store/auth';
import { mainRouter } from '@/router';

const props = defineProps<{
	bucketName: string;
	filePath: string;
}>();

const downloadUrl = computed(() => `/d/${props.bucketName}/${props.filePath}`);
const isImage = computed(() => {
	const ext = props.filePath.split('.').pop()?.toLowerCase() ?? '';
	return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext);
});
const isText = computed(() => {
	const ext = props.filePath.split('.').pop()?.toLowerCase() ?? '';
	return ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'yaml', 'yml', 'toml', 'sh', 'csv'].includes(ext);
});

const deleteError = ref('');

const parentPath = computed(() => {
	const parts = props.filePath.split('/');
	parts.pop();
	return parts.length === 0
		? `/v/${props.bucketName}/`
		: `/v/${props.bucketName}/${parts.join('/')}/`;
});

async function deleteFile(): Promise<void> {
	if (!confirm(`ファイル「${props.filePath}」を削除しますか？`)) return;
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
    <template v-if="isImage">
      <img :src="downloadUrl" :alt="filePath" style="max-width:100%; max-height:600px;">
      <br>
    </template>
    <p>
      <a :href="downloadUrl" download>ダウンロード</a>
    </p>
    <p v-if="isText">
      <a :href="downloadUrl" target="_blank">ブラウザで開く</a>
    </p>
    <p v-if="authStore.user">
      <button type="button" @click="deleteFile">削除</button>
      <span v-if="deleteError" style="color:red; margin-left:8px">{{ deleteError }}</span>
    </p>
  </div>
</template>
