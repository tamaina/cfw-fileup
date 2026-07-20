<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { AlertDialog } from '@vuetify/v0';
import { Clapperboard } from '@lucide/vue';
import HlsVideoPreview from '@/components/HlsVideoPreview.vue';
import AdSlot from '@/components/AdSlot.vue';
import PreviewInterstitialAd from '@/components/PreviewInterstitialAd.vue';
import FileActionBar from '@/components/FileActionBar.vue';
import { authHeaders } from '@/store/auth';
import { archiveEntryStreamUrl } from '@/utils/archive-entry-url';
import { hlsPosterEntryPath, parseHlsAttributeList, parseHlsSessionData } from '../../shared/hls';
import type { DownloadTransformWorkerMessage, DownloadTransformWorkerRequestInput, DownloadTransformProgress } from '@/workers/download-transform.worker';
import { getOpfsTempFile, removeOpfsTempFile } from '@/workers/opfs-temp';
import { cancelDownloadStatus, completeDownloadStatus, failDownloadStatus, startDownloadStatus, updateDownloadStatus } from '@/store/download-status';
import { registerDownloadedOpfsFile } from '@/store/download-cleanup';
import { DownloadCancelledError, resolveSaveTarget, type WorkerDownloadResult } from '@/utils/save-file';

const props = defineProps<{
	fileId: string;
	filename: string;
	bucketName?: string;
	filePath?: string;
	bucketId?: string | null;
	isOwner?: boolean;
	isModerationForcedPrivate?: boolean;
	hideManagement?: boolean;
	token?: string | null;
	showAds?: boolean;
	ownerCanDisableFileAds?: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:isModerationForcedPrivate', value: boolean): void;
}>();

const masterUrl = ref('');
const masterPath = ref('');
const hlsTitle = ref('');
const posterUrl = ref('');
const error = ref('');
const previewAdCompleted = ref(false);
const downloadError = ref('');
const downloadProgress = ref<DownloadTransformProgress | null>(null);
const variants = ref<HlsVariant[]>([]);
const selectedVariantUrl = ref('');
const downloadDialogOpen = ref(false);
let downloadTransformWorker: Worker | null = null;
let downloadTransformRequestId = 0;
const downloadTransformRequests = new Map<string, {
	resolve: (value: WorkerDownloadResult) => void;
	reject: (error: Error & { opfsName?: string }) => void;
}>();

const videoFilename = computed(() => {
	const leaf = props.filename.split('/').filter(Boolean).at(-1) ?? props.filename;
	const dot = leaf.lastIndexOf('.');
	return `${dot > 0 ? leaf.slice(0, dot) : leaf}.mp4`;
});
const selectedDownloadUrl = computed(() => selectedVariantUrl.value || masterUrl.value);
const actionFilePath = computed(() => props.filePath ?? props.filename);
const actionBucketName = computed(() => props.bucketName ?? '');

type HlsVariant = {
	readonly url: string;
	readonly label: string;
};

function downloadUrl(): string {
	const base = `/d/${props.fileId}`;
	return props.token ? `${base}?token=${encodeURIComponent(props.token)}` : base;
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
			pending.resolve({ opfsName: message.opfsName, savedDirectly: message.savedDirectly, filename: message.filename, mimeType: message.mimeType });
		} else {
			const err = new Error(message.error) as Error & { opfsName?: string };
			err.opfsName = message.opfsName;
			pending.reject(err);
		}
	};
	return downloadTransformWorker;
}

function runDownloadTransformWorker(request: DownloadTransformWorkerRequestInput): Promise<WorkerDownloadResult> {
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

async function downloadOpfsFile(result: WorkerDownloadResult): Promise<void> {
	// showSaveFilePicker で直接保存済みの場合は何もしない
	if (result.savedDirectly || !result.opfsName) return;
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

async function downloadAsMp4(): Promise<void> {
	downloadError.value = '';
	downloadProgress.value = null;
	if (!selectedDownloadUrl.value) {
		downloadError.value = 'HLS プレイリストがまだ読み込まれていません。';
		return;
	}
	const statusId = String(downloadTransformRequestId + 1);
	try {
		const saveTarget = await resolveSaveTarget(videoFilename.value, 'video/mp4');
		startDownloadStatus(statusId, videoFilename.value);
		const result = await runDownloadTransformWorker({
			mode: 'hls-to-mp4',
			url: selectedDownloadUrl.value,
			filename: videoFilename.value,
			token: props.token,
			authHeaders: authHeaders(),
			fileHandle: saveTarget.kind === 'picker' ? saveTarget.fileHandle : undefined,
		});
		await downloadOpfsFile(result);
		completeDownloadStatus(statusId);
		downloadProgress.value = null;
	} catch (err) {
		if (err instanceof DownloadCancelledError) {
			cancelDownloadStatus(statusId);
			downloadProgress.value = null;
			return;
		}
		await cleanupTempFile((err as Error & { opfsName?: string }).opfsName);
		downloadTransformWorker?.terminate();
		downloadTransformWorker = null;
		console.error('HLS MP4 download failed', err, {
			fileId: props.fileId,
			selectedDownloadUrl: selectedDownloadUrl.value,
		});
		const message = err instanceof Error ? err.message : String(err);
		failDownloadStatus(statusId, message);
		downloadError.value = message;
	}
}

function openDownloadDialog(): void {
	downloadError.value = '';
	downloadDialogOpen.value = true;
}

async function confirmVideoDownload(): Promise<void> {
	downloadDialogOpen.value = false;
	await downloadAsMp4();
}

async function loadMasterPlaylist(): Promise<void> {
	masterUrl.value = '';
	masterPath.value = '';
	hlsTitle.value = '';
	posterUrl.value = '';
	error.value = '';
	variants.value = [];
	selectedVariantUrl.value = '';
	if (!props.fileId) return;

	const listUrl = props.token
		? `/d/${props.fileId}?list&token=${encodeURIComponent(props.token)}`
		: `/d/${props.fileId}?list`;
	try {
		const res = await fetch(listUrl, { headers: authHeaders() });
		if (!res.ok) {
			error.value = `HLS 情報の取得に失敗しました: ${res.status}`;
			return;
		}
		const entries = await res.json() as Array<{ path: string; mimeType: string }>;
		const master = entries.find(entry => entry.path.split('/').pop() === 'master.m3u8')
			?? entries.find(entry => entry.path.toLowerCase().endsWith('.m3u8'));
		if (!master) {
			error.value = 'HLS プレイリストが見つかりません。';
			return;
		}
		masterPath.value = master.path;
		masterUrl.value = archiveEntryStreamUrl(props.fileId, master.path, props.token);
		const masterText = await fetchText(masterUrl.value);
		variants.value = parseMasterPlaylistVariants(masterUrl.value, masterText);
		selectedVariantUrl.value = variants.value[0]?.url ?? '';
		const sessionMeta = parseHlsSessionData(masterText);
		hlsTitle.value = sessionMeta.title ?? '';
		const posterPath = hlsPosterEntryPath(master.path);
		if (entries.some(entry => entry.path === posterPath)) {
			posterUrl.value = archiveEntryStreamUrl(props.fileId, posterPath, props.token);
		}
	} catch (err) {
		console.error('HLS playlist preview failed', err, { fileId: props.fileId });
		error.value = err instanceof Error ? err.message : String(err);
	}
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) throw new Error(`HLS プレイリストの取得に失敗しました: ${res.status}`);
	return await res.text();
}

function parseMasterPlaylistVariants(baseUrl: string, text: string): HlsVariant[] {
	const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	const result: HlsVariant[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
		const uri = lines.slice(i + 1).find(candidate => !candidate.startsWith('#'));
		if (!uri) continue;
		const attrs = parseHlsAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
		const url = new URL(uri, new URL(baseUrl, location.origin)).toString();
		result.push({ url, label: variantLabel(attrs, result.length + 1) });
	}
	return result;
}

function variantLabel(attrs: Record<string, string>, index: number): string {
	const parts: string[] = [];
	if (attrs.RESOLUTION) parts.push(attrs.RESOLUTION);
	const bandwidth = Number(attrs.BANDWIDTH);
	if (Number.isFinite(bandwidth) && bandwidth > 0) parts.push(`${(bandwidth / 1_000_000).toFixed(bandwidth >= 1_000_000 ? 1 : 2)} Mbps`);
	if (attrs.CODECS) parts.push(attrs.CODECS);
	return parts.length > 0 ? parts.join(' / ') : `バリエーション ${index}`;
}

function completePreviewAd(): void {
	previewAdCompleted.value = true;
}

watch(() => [props.fileId, props.token], () => {
	previewAdCompleted.value = false;
	void loadMasterPlaylist();
}, { immediate: true });

onBeforeUnmount(() => {
	downloadTransformWorker?.terminate();
	downloadTransformWorker = null;
});
</script>

<template>
  <FileActionBar
    :class="$style.actions"
    :bucket-name="actionBucketName"
    :file-path="actionFilePath"
    :file-id="fileId"
    :bucket-id="bucketId ?? null"
    :download-url="downloadUrl()"
    :download-filename="filename"
    :is-owner="isOwner"
    :is-moderation-forced-private="isModerationForcedPrivate"
    :hide-management="hideManagement"
    @update:is-moderation-forced-private="emit('update:isModerationForcedPrivate', $event)"
  >
    <button type="button" class="btn btn-secondary" :disabled="downloadProgress != null || !selectedDownloadUrl" @click="openDownloadDialog">
      <Clapperboard :size="16" :stroke-width="2" aria-hidden="true" />
      MP4ダウンロード
    </button>
  </FileActionBar>

  <AlertDialog.Root v-model="downloadDialogOpen">
    <AlertDialog.Content :class="$style.downloadDialog">
      <div :class="$style.downloadDialogInner">
        <AlertDialog.Title :class="$style.downloadDialogTitle">動画としてダウンロード</AlertDialog.Title>
        <div :class="$style.downloadDialogBody">
          <label v-if="variants.length > 1" class="form-group">
            <span class="form-label">画質</span>
            <select v-model="selectedVariantUrl" class="form-input">
              <option v-for="variant in variants" :key="variant.url" :value="variant.url">{{ variant.label }}</option>
            </select>
          </label>
          <div v-else :class="$style.singleVariant">
            {{ variants[0]?.label ?? '自動' }}
          </div>
        </div>
        <div :class="$style.downloadDialogActions">
          <AlertDialog.Cancel class="btn btn-secondary" type="button">キャンセル</AlertDialog.Cancel>
          <button type="button" class="btn btn-primary" :disabled="downloadProgress != null || !selectedDownloadUrl" @click="confirmVideoDownload">
            ダウンロード
          </button>
        </div>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Root>

  <PreviewInterstitialAd
    v-if="showAds !== false && !previewAdCompleted"
    :owner-can-disable-file-ads="ownerCanDisableFileAds"
    @complete="completePreviewAd"
  />

  <AdSlot
    v-if="showAds !== false"
    :owner-can-disable-file-ads="ownerCanDisableFileAds"
  />

  <section class="card" :class="$style.root">
    <div :class="$style.header">
      <div>
        <h2 :class="$style.title">{{ hlsTitle || 'ストリーミング再生' }}</h2>
      </div>
    </div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <HlsVideoPreview v-else-if="masterUrl" :src="masterUrl" :token="token" :poster="posterUrl || null" />
    <div v-else class="page-loading">
      <span class="spinner"></span>読み込み中...
    </div>
  </section>
  <div v-if="downloadError" class="alert alert-error mt-3">{{ downloadError }}</div>
</template>

<style module lang="scss">
.actions {
  margin-top: 0;
  margin-bottom: 12px;
}

.root {
  display: grid;
  gap: 12px;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.title {
  margin: 0;
  font-size: 1rem;
}

.path {
  margin: 4px 0 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  word-break: break-all;
}

.downloadDialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  width: min(440px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.downloadDialogInner {
  display: grid;
  gap: 16px;
  padding: 24px;
}

.downloadDialogTitle {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
}

.downloadDialogBody {
  display: grid;
  gap: 8px;
}

.singleVariant {
  min-height: 40px;
  display: flex;
  align-items: center;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.downloadDialogActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
