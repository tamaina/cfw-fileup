<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import { PackageOpen } from '@lucide/vue';
import { authHeaders } from '@/store/auth';
import type { DownloadTransformWorkerMessage, DownloadTransformWorkerRequestInput, DownloadTransformProgress } from '@/workers/download-transform.worker';
import { getOpfsTempFile, removeOpfsTempFile } from '@/workers/opfs-temp';
import { completeDownloadStatus, failDownloadStatus, startDownloadStatus, updateDownloadStatus } from '@/store/download-status';
import { registerDownloadedOpfsFile } from '@/store/download-cleanup';
import MarkdownPreview from '@/components/MarkdownPreview.vue';
import RawTextPreview from '@/components/RawTextPreview.vue';
import JsonPreview from '@/components/JsonPreview.vue';
import HlsVideoPreview from '@/components/HlsVideoPreview.vue';
import PreviewInterstitialAd from '@/components/PreviewInterstitialAd.vue';
import FileActionBar from '@/components/FileActionBar.vue';
import { parseExifDisplayItems, type ExifDisplayItem } from '@/utils/exif';

const props = withDefaults(defineProps<{
	bucketName: string;
	filePath: string;
	fileId: string;
	bucketId: string | null;
	isOwner?: boolean;
	isModerationForcedPrivate?: boolean;
	ownerCanDisableFileAds?: boolean;
	token?: string;
	downloadUrlOverride?: string;
	previewUrl?: string;
	downloadFilename?: string;
	downloadErrorOverride?: string;
	mimeType?: string | null;
	extensionMimeType?: string | null;
	hasMimeTypeMismatch?: boolean;
	hasExecutableContent?: boolean;
	reportPath?: string;
	hideManagement?: boolean;
	showAds?: boolean;
	/** HLS プレイリスト再生用URL（スラッシュ温存）。アーカイブ内 m3u8 エントリーで指定される */
	hlsUrl?: string;
}>(), {
	showAds: true,
});

const emit = defineEmits<{
	(e: 'update:isModerationForcedPrivate', value: boolean): void;
	(e: 'download', event: MouseEvent): void;
}>();

const downloadUrl = computed(() => {
	if (props.downloadUrlOverride) return props.downloadUrlOverride;
	if (!props.fileId) return '';
	const base = `/d/${props.fileId}`;
	return props.token ? `${base}?token=${props.token}` : base;
});
const previewUrl = computed(() => props.previewUrl || downloadUrl.value);
const downloadFilename = computed(() => props.downloadFilename || props.filePath.split('/').filter(Boolean).at(-1) || 'download');
const displayFilename = computed(() => props.filePath.split('/').filter(Boolean).at(-1) || props.filePath || 'download');
const visibleMimeType = computed(() => props.mimeType ?? null);
const visibleExtensionMimeType = computed(() => props.extensionMimeType ?? null);
const isGz = computed(() => {
	const lower = props.filePath.toLowerCase();
	return lower.endsWith('.gz') && !lower.endsWith('.tar.gz');
});
const isImage = computed(() => {
	const ext = props.filePath.split('.').pop()?.toLowerCase() ?? '';
	return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext);
});
const isHlsPlaylist = computed(() => {
	if (props.filePath.toLowerCase().endsWith('.m3u8')) return true;
	const mime = (props.mimeType ?? '').toLowerCase();
	return mime === 'application/vnd.apple.mpegurl' || mime === 'audio/mpegurl' || mime === 'application/x-mpegurl';
});
const isMarkdown = computed(() => {
	const lower = props.filePath.toLowerCase();
	return lower.endsWith('.md') || lower.endsWith('.markdown');
});
const isJson = computed(() => {
	const lower = props.filePath.toLowerCase();
	return lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.geojson');
});
const isTextLike = computed(() => {
	const lower = props.filePath.toLowerCase();
	const ext = lower.split('.').pop() ?? '';
	return ['txt', 'json', 'csv', 'ts', 'js', 'mjs', 'jsx', 'tsx', 'vue', 'css', 'scss', 'html', 'xml', 'yml', 'yaml', 'md', 'markdown', 'c', 'cc', 'cpp', 'cs', 'go', 'h', 'hpp', 'java', 'kt', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'svelte', 'swift'].includes(ext);
});

const downloadError = ref('');
const visibleDownloadError = computed(() => props.downloadErrorOverride || downloadError.value);
const downloadProgress = ref<DownloadTransformProgress | null>(null);
const exifItems = ref<ExifDisplayItem[]>([]);
const previewAdCompleted = ref(false);
let downloadTransformWorker: Worker | null = null;
let downloadTransformRequestId = 0;
const downloadTransformRequests = new Map<string, {
	resolve: (value: { opfsName: string; filename: string; mimeType: string }) => void;
	reject: (error: Error & { opfsName?: string }) => void;
}>();

const canShowPreview = computed(() => props.showAds === false || previewAdCompleted.value);

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

function runDownloadTransformWorker(request: DownloadTransformWorkerRequestInput): Promise<{ opfsName: string; filename: string; mimeType: string }> {
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

async function loadExif(): Promise<void> {
	exifItems.value = [];
	if (!canShowPreview.value || !isImage.value || !previewUrl.value) return;
	const requestUrl = previewUrl.value;
	try {
		const res = await fetch(requestUrl, {
			headers: {
				...authHeaders(),
				Range: 'bytes=0-262143',
			},
		});
		if (requestUrl !== previewUrl.value) return;
		if (!res.ok) return;
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (requestUrl !== previewUrl.value) return;
		exifItems.value = parseExifDisplayItems(bytes);
	} catch { /* no EXIF preview */ }
}

function completePreviewAd(): void {
	previewAdCompleted.value = true;
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
		console.error('Transformed file download failed', err, { fileId: props.fileId, filePath: props.filePath });
		const message = err instanceof Error ? err.message : String(err);
		failDownloadStatus(statusId, message);
		downloadError.value = message;
	}
}

onBeforeUnmount(() => {
	downloadTransformWorker?.terminate();
	downloadTransformWorker = null;
});
watch([isImage, previewUrl], () => {
	void loadExif();
}, { immediate: true });
watch(() => `${props.fileId}:${props.filePath}:${previewUrl.value}`, () => {
	previewAdCompleted.value = false;
	exifItems.value = [];
});
watch(canShowPreview, () => {
	void loadExif();
});
</script>

<template>
  <div>
    <div v-if="hasMimeTypeMismatch" :class="['alert', 'alert-warning', 'mb-3', $style.fileTypeWarning]">
      <p :class="$style.fileTypeWarningLine">ファイル名の拡張子と内容が一致していない可能性があります。</p>
      <p v-if="hasExecutableContent" :class="$style.fileTypeWarningLine">実行可能ファイルとして検出されています。</p>
      <p v-if="visibleMimeType || visibleExtensionMimeType" :class="$style.fileTypeWarningLine">内容: {{ visibleMimeType ?? '不明' }} / 拡張子: {{ visibleExtensionMimeType ?? '不明' }}</p>
    </div>

    <FileActionBar
      :bucket-name="bucketName"
      :file-path="filePath"
      :file-id="fileId"
      :bucket-id="bucketId"
      :download-url="downloadUrl"
      :download-filename="downloadFilename"
      :is-owner="isOwner"
      :is-moderation-forced-private="isModerationForcedPrivate"
      :report-path="reportPath"
      :hide-management="hideManagement"
      @download="emit('download', $event)"
      @update:is-moderation-forced-private="emit('update:isModerationForcedPrivate', $event)"
    >
      <button v-if="!hideManagement && isGz" type="button" class="btn btn-secondary" :disabled="downloadProgress != null" @click="startDecompressedDownload">
        <PackageOpen :size="16" :stroke-width="2" aria-hidden="true" />
        展開してダウンロード
      </button>
    </FileActionBar>

    <PreviewInterstitialAd
      v-if="fileId && showAds !== false && !previewAdCompleted"
      :owner-can-disable-file-ads="ownerCanDisableFileAds"
      @complete="completePreviewAd"
    />

    <div v-if="canShowPreview && isImage" :class="[$style.imagePreview, exifItems.length > 0 ? $style.imagePreviewWithExif : null]">
      <img :src="previewUrl" :alt="filePath" class="file-preview-image">
      <aside v-if="exifItems.length > 0" :class="$style.exifPanel" aria-label="EXIF情報">
        <h3 :class="$style.exifTitle" :title="displayFilename">{{ displayFilename }}</h3>
        <dl :class="$style.exifList">
          <template v-for="item in exifItems" :key="item.label">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </template>
        </dl>
      </aside>
    </div>
    <HlsVideoPreview v-else-if="canShowPreview && isHlsPlaylist && hlsUrl" :src="hlsUrl" :token="token" :class="$style.hlsPreview" />
    <MarkdownPreview v-else-if="canShowPreview && isMarkdown" :url="previewUrl" :filename="filePath" :class="$style.markdownPreview" />
    <JsonPreview v-else-if="canShowPreview && isJson" :url="previewUrl" :filename="filePath" :class="$style.jsonPreview" />
    <RawTextPreview v-else-if="canShowPreview && (isTextLike || isHlsPlaylist)" :url="previewUrl" :filename="filePath" :class="$style.rawPreview" />

    <div v-if="visibleDownloadError" class="alert alert-error mt-3">{{ visibleDownloadError }}</div>
  </div>
</template>

<style module lang="scss">
.imagePreview {
  margin-top: 16px;
}

.imagePreviewWithExif {
  display: grid;
  grid-template-columns: minmax(0, max-content) minmax(220px, 320px);
  align-items: start;
  gap: 16px;
}

.exifPanel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  padding: 16px 16px 8px;
}

.exifTitle {
  margin: 0 0 12px;
  font-size: 1rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.exifList {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0 14px;
  margin: 0;
  font-size: 0.85rem;

  dt {
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    padding: 8px 0;
  }

  dd {
    border-top: 1px solid var(--color-border);
    margin: 0;
    padding: 8px 0;
    overflow-wrap: anywhere;
  }
}

.hlsPreview {
  margin-top: 16px;
}

.markdownPreview {
  margin-top: 16px;
}

.jsonPreview {
  margin-top: 16px;
}

.rawPreview {
  margin-top: 16px;
}

.fileTypeWarning {
  display: grid;
  gap: 4px;
}

.fileTypeWarningLine {
  margin: 0;
}

@media (max-width: 640px) {
  .imagePreviewWithExif {
    grid-template-columns: 1fr;
  }

  .exifPanel {
    width: 100%;
  }

}
</style>
