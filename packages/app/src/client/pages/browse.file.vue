<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue';
import { Button } from '@vuetify/v0';
import { authHeaders, authStore } from '@/store/auth';
import { apiPost } from '@/utils/api';
import { mainRouter } from '@/router';
import ConfirmDialog from '@/components/confirm-dialog.vue';
import type { DownloadTransformWorkerMessage, DownloadTransformWorkerRequest, DownloadTransformProgress } from '@/workers/download-transform.worker';
import { getOpfsTempFile, removeOpfsTempFile } from '@/workers/opfs-temp';
import { completeDownloadStatus, failDownloadStatus, startDownloadStatus, updateDownloadStatus } from '@/store/download-status';
import { registerDownloadedOpfsFile } from '@/store/download-cleanup';

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
const downloadError = ref('');
const downloadProgress = ref<DownloadTransformProgress | null>(null);
let downloadTransformWorker: Worker | null = null;
let downloadTransformRequestId = 0;
const downloadTransformRequests = new Map<string, {
	resolve: (value: { opfsName: string; filename: string; mimeType: string }) => void;
	reject: (error: Error & { opfsName?: string }) => void;
}>();

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

function getDownloadTransformWorker(): Worker {
	if (downloadTransformWorker) return downloadTransformWorker;
	downloadTransformWorker = new Worker(new URL('../workers/download-transform.worker.ts', import.meta.url), { type: 'module' });
	downloadTransformWorker.onmessage = (event: MessageEvent<DownloadTransformWorkerMessage>) => {
		const message = event.data;
		if (message.type === 'progress') {
			downloadProgress.value = message.progress;
			updateDownloadStatus(message.id, message.progress);
			return;
		}
		const pending = downloadTransformRequests.get(message.id);
		if (!pending) return;
		downloadTransformRequests.delete(message.id);
		if (message.type === 'done') {
			pending.resolve({ opfsName: message.opfsName, filename: message.filename, mimeType: message.mimeType });
		} else if (message.type === 'error') {
			const error = new Error(message.error) as Error & { opfsName?: string };
			error.opfsName = message.opfsName;
			pending.reject(error);
		}
	};
	return downloadTransformWorker;
}

function runDownloadTransformWorker(request: Omit<DownloadTransformWorkerRequest, 'id'>): Promise<{ opfsName: string; filename: string; mimeType: string }> {
	const id = String(++downloadTransformRequestId);
	return new Promise((resolve, reject) => {
		downloadTransformRequests.set(id, { resolve, reject });
		getDownloadTransformWorker().postMessage({ ...request, id });
	});
}

async function cleanupTempFile(opfsName: string | undefined): Promise<void> {
	if (!opfsName) return;
	await removeOpfsTempFile(opfsName);
}

async function downloadOpfsFile(result: { opfsName: string; filename: string; mimeType: string }): Promise<void> {
	const sourceFile = await getOpfsTempFile(result.opfsName);
	const file = new File([sourceFile], result.filename, { type: result.mimeType, lastModified: sourceFile.lastModified });
	const url = URL.createObjectURL(file);
	registerDownloadedOpfsFile(url, result.opfsName);
	const a = document.createElement('a');
	a.href = url;
	a.download = result.filename;
	document.body.append(a);
	a.click();
	a.remove();
}

function decompressedFilename(path: string): string {
	return path.toLowerCase().endsWith('.gz') ? path.slice(0, -3) : path;
}

async function startDecompressedDownload(): Promise<void> {
	downloadError.value = '';
	downloadProgress.value = null;
	if (!navigator.storage?.getDirectory) {
		downloadError.value = 'このブラウザは OPFS に対応していないため、展開してダウンロードできません。';
		return;
	}
	const statusId = String(downloadTransformRequestId + 1);
	const filename = decompressedFilename(props.filePath);
	startDownloadStatus(statusId, filename);
	try {
		const result = await runDownloadTransformWorker({
			mode: 'download',
			url: downloadUrl.value,
			filename,
			mimeType: 'application/octet-stream',
			transform: 'decompress-gzip',
			authHeaders: authHeaders(),
		});
		await downloadOpfsFile(result);
		completeDownloadStatus(statusId);
		downloadProgress.value = null;
	} catch (err) {
		await cleanupTempFile((err as Error & { opfsName?: string }).opfsName);
		downloadTransformWorker?.terminate();
		downloadTransformWorker = null;
		const message = err instanceof Error ? err.message : String(err);
		failDownloadStatus(statusId, message);
		downloadError.value = message;
	}
}

onBeforeUnmount(() => {
	downloadTransformWorker?.terminate();
	downloadTransformWorker = null;
});
</script>

<template>
  <div>
    <div class="card file-actions">
      <a :href="downloadUrl" download class="btn btn-primary">ダウンロード</a>
      <button v-if="isGz" type="button" class="btn btn-secondary" :disabled="downloadProgress != null" @click="startDecompressedDownload">展開してダウンロード</button>
      <a v-if="isText" :href="downloadUrl" target="_blank" class="btn btn-secondary">ブラウザで開く</a>
      <Button.Root v-if="authStore.user" class="btn btn-ghost-danger" @click="deleteDialog = true">
        <Button.Content>削除</Button.Content>
      </Button.Root>
    </div>

    <div v-if="isImage" :class="$style.imagePreview">
      <img :src="downloadUrl" :alt="filePath" class="file-preview-image">
    </div>

    <div v-if="downloadError" class="alert alert-error mt-3">{{ downloadError }}</div>
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
