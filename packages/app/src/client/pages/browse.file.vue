<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import { PackageOpen, ShieldCheck } from '@lucide/vue';
import { authHeaders } from '@/store/auth';
import type { DownloadTransformProgress } from '@/workers/download-transform.worker';
import { getOpfsTempFile, removeOpfsTempFile } from '@/workers/opfs-temp';
import { cancelDownloadStatus, completeDownloadStatus, failDownloadStatus, startDownloadStatus } from '@/store/download-status';
import { registerDownloadedOpfsFile } from '@/store/download-cleanup';
import { runDownloadTransform, setProgressCallback, removeProgressCallback, terminateDownloadTransformWorker } from '@/store/download-worker';
import { DownloadCancelledError, StorageQuotaExceededError, resolveSaveTarget, type WorkerDownloadResult } from '@/utils/save-file';
import MarkdownPreview from '@/components/MarkdownPreview.vue';
import RawTextPreview from '@/components/RawTextPreview.vue';
import JsonPreview from '@/components/JsonPreview.vue';
import HlsVideoPreview from '@/components/HlsVideoPreview.vue';
import PreviewInterstitialAd from '@/components/PreviewInterstitialAd.vue';
import FileActionBar from '@/components/FileActionBar.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StorageQuotaDialog from '@/components/StorageQuotaDialog.vue';
import { parseExifDisplayItems, type ExifDisplayItem } from '@/utils/exif';
import { AES_CTR_IV_LENGTH, decryptBlob, importAesCtrKey, multibaseToKey } from '../../shared/encryption';

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
	/** ファイル本体がE2E暗号化されているかどうか。プレビューの表示判定に使う */
	isEncrypted?: boolean;
	/** 暗号化キー（multibase形式）。指定されるとダウンロード時に復号する */
	encryptionKey?: string;
	/** ファイルサイズ（バイト）。OPFS クォータ事前チェックに使う */
	fileSize?: number | null;
}>(), {
	showAds: true,
});

const emit = defineEmits<{
	(e: 'update:isModerationForcedPrivate', value: boolean): void;
	(e: 'download', event: MouseEvent): void;
	(e: 'addEncryptionKey', key: string): void;
}>();

const downloadUrl = computed(() => {
	if (props.downloadUrlOverride) return props.downloadUrlOverride;
	if (!props.fileId) return '';
	const base = `/d/${props.fileId}`;
	return props.token ? `${base}?token=${props.token}` : base;
});
const previewUrl = computed(() => props.previewUrl || decryptedPreviewUrl.value || downloadUrl.value);
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
const quotaDialog = ref<{ requiredBytes: number; availableBytes: number } | null>(null);
const exifItems = ref<ExifDisplayItem[]>([]);
const previewAdCompleted = ref(false);
/** 現在進行中のダウンロード ID（unmount 時に進捗コールバック解除用） */
let currentDownloadId: string | null = null;

const canShowPreview = computed(() => props.showAds === false || previewAdCompleted.value);

/** 暗号化ファイルで鍵が利用できないとき、プレビューを差し止める */
const encryptedPreviewUnavailable = computed(() => props.isEncrypted === true && !props.encryptionKey);

// --- 暗号化ファイルの復号プレビュー ---
const DECRYPT_PREVIEW_MAX_BYTES = 256 * 1024;
const decryptedPreviewUrl = ref('');
let decryptedPreviewGeneration = 0;

const isPreviewableContent = computed(() => isImage.value || isMarkdown.value || isJson.value || isTextLike.value);
const needsDecryptedPreview = computed(() =>
	props.isEncrypted === true &&
	!!props.encryptionKey &&
	isPreviewableContent.value &&
	!decryptedPreviewUrl.value &&
	!props.downloadUrlOverride,
);

function revokeDecryptedPreviewUrl(): void {
	if (decryptedPreviewUrl.value) {
		URL.revokeObjectURL(decryptedPreviewUrl.value);
		decryptedPreviewUrl.value = '';
	}
}

async function refreshDecryptedPreview(): Promise<void> {
	const generation = ++decryptedPreviewGeneration;
	revokeDecryptedPreviewUrl();
	if (!needsDecryptedPreview.value || !props.encryptionKey) return;
	const rawKey = multibaseToKey(props.encryptionKey);
	if (!rawKey) return;
	try {
		const cryptoKey = await importAesCtrKey(rawKey, ['decrypt']);
		const headers: Record<string, string> = { ...authHeaders() };
		// AES-CTRは先頭から独立して復号できるため、テキスト系プレビューは部分取得で十分
		if (!isImage.value) {
			headers.Range = `bytes=0-${AES_CTR_IV_LENGTH + DECRYPT_PREVIEW_MAX_BYTES - 1}`;
		}
		const res = await fetch(downloadUrl.value, { headers });
		if (generation !== decryptedPreviewGeneration) return;
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const blob = await res.blob();
		if (generation !== decryptedPreviewGeneration) return;
		const decrypted = await decryptBlob(blob, cryptoKey);
		if (generation !== decryptedPreviewGeneration) return;
		decryptedPreviewUrl.value = URL.createObjectURL(decrypted);
	} catch (err) {
		if (generation !== decryptedPreviewGeneration) return;
		console.error('Failed to decrypt preview', err, { fileId: props.fileId, filePath: props.filePath });
	}
}

watch([needsDecryptedPreview, () => props.encryptionKey, downloadUrl], () => {
	void refreshDecryptedPreview();
}, { immediate: true });

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
	const filename = decompressedFilename(props.filePath);
	let downloadId: string | null = null;
	try {
		const saveTarget = await resolveSaveTarget(filename, 'application/octet-stream', props.fileSize ?? undefined);
		const { id, promise } = runDownloadTransform({
			mode: 'download',
			url: downloadUrl.value,
			filename,
			mimeType: 'application/octet-stream',
			transform: 'decompress-gzip',
			encryptionKey: props.encryptionKey,
			authHeaders: authHeaders(),
			fileHandle: saveTarget.kind === 'picker' ? saveTarget.fileHandle : undefined,
			writable: saveTarget.kind === 'stream' ? saveTarget.writable : undefined,
		});
		downloadId = id;
		currentDownloadId = id;
		setProgressCallback(id, (p) => { downloadProgress.value = p as DownloadTransformProgress; });
		startDownloadStatus(id, filename);
		const result = await promise;
		removeProgressCallback(id);
		currentDownloadId = null;
		await downloadOpfsFile(result);
		completeDownloadStatus(id);
		downloadProgress.value = null;
	} catch (err) {
		if (downloadId) { removeProgressCallback(downloadId); currentDownloadId = null; }
		if (err instanceof DownloadCancelledError) {
			if (downloadId) cancelDownloadStatus(downloadId);
			downloadProgress.value = null;
			return;
		}
		if (err instanceof StorageQuotaExceededError) {
			quotaDialog.value = { requiredBytes: err.requiredBytes, availableBytes: err.availableBytes };
			downloadProgress.value = null;
			return;
		}
		await cleanupTempFile((err as Error & { opfsName?: string }).opfsName);
		terminateDownloadTransformWorker();
		console.error('Transformed file download failed', err, { fileId: props.fileId, filePath: props.filePath });
		const message = err instanceof Error ? err.message : String(err);
		if (downloadId) failDownloadStatus(downloadId, message);
		downloadError.value = message;
	}
}

/** 暗号化ファイルのダウンロード: ワーカーで復号してから保存 */
async function startEncryptedDownload(): Promise<void> {
	downloadError.value = '';
	downloadProgress.value = null;
	const filename = downloadFilename.value;
	let downloadId: string | null = null;
	try {
		const saveTarget = await resolveSaveTarget(filename, props.mimeType ?? 'application/octet-stream', props.fileSize ?? undefined);
		const { id, promise } = runDownloadTransform({
			mode: 'download',
			url: downloadUrl.value,
			filename,
			mimeType: props.mimeType ?? 'application/octet-stream',
			transform: 'none',
			encryptionKey: props.encryptionKey,
			authHeaders: authHeaders(),
			fileHandle: saveTarget.kind === 'picker' ? saveTarget.fileHandle : undefined,
			writable: saveTarget.kind === 'stream' ? saveTarget.writable : undefined,
		});
		downloadId = id;
		currentDownloadId = id;
		setProgressCallback(id, (p) => { downloadProgress.value = p as DownloadTransformProgress; });
		startDownloadStatus(id, filename);
		const result = await promise;
		removeProgressCallback(id);
		currentDownloadId = null;
		await downloadOpfsFile(result);
		completeDownloadStatus(id);
		downloadProgress.value = null;
	} catch (err) {
		if (downloadId) { removeProgressCallback(downloadId); currentDownloadId = null; }
		if (err instanceof DownloadCancelledError) {
			if (downloadId) cancelDownloadStatus(downloadId);
			downloadProgress.value = null;
			return;
		}
		if (err instanceof StorageQuotaExceededError) {
			quotaDialog.value = { requiredBytes: err.requiredBytes, availableBytes: err.availableBytes };
			downloadProgress.value = null;
			return;
		}
		await cleanupTempFile((err as Error & { opfsName?: string }).opfsName);
		terminateDownloadTransformWorker();
		console.error('Encrypted file download failed', err, { fileId: props.fileId, filePath: props.filePath });
		const message = err instanceof Error ? err.message : String(err);
		if (downloadId) failDownloadStatus(downloadId, message);
		downloadError.value = message;
	}
}

const encryptedDownloadConfirmOpen = ref(false);

function handleDownloadClick(event: MouseEvent): void {
	// 暗号化アーカイブエントリーで鍵あり: 親(browse.vue)が復号してダウンロードする
	if (props.isEncrypted && props.encryptionKey && props.downloadUrlOverride) {
		emit('download', event);
		return;
	}
	if (props.isEncrypted) {
		event.preventDefault();
		if (props.encryptionKey) {
			// 暗号化ファイル本体: ワーカーで復号してダウンロード
			void startEncryptedDownload();
		} else {
			// 鍵なし: 暗号化されたままダウンロードしてよいか確認する
			encryptedDownloadConfirmOpen.value = true;
		}
		return;
	}
	emit('download', event);
}

/** 復号キーがないまま、暗号化されたファイルをそのままダウンロードする */
function confirmEncryptedDownload(): void {
	const url = downloadUrl.value;
	if (!url) return;
	const a = document.createElement('a');
	a.href = url;
	a.download = downloadFilename.value;
	document.body.append(a);
	a.click();
	a.remove();
}

onBeforeUnmount(() => {
	if (currentDownloadId) removeProgressCallback(currentDownloadId);
	revokeDecryptedPreviewUrl();
});
watch([isImage, previewUrl], () => {
	void loadExif();
}, { immediate: true });
watch(() => `${props.fileId}:${props.filePath}`, () => {
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
      :is-encrypted="isEncrypted"
      :has-encryption-key="encryptionKey != null"
      @download="handleDownloadClick"
      @update:is-moderation-forced-private="emit('update:isModerationForcedPrivate', $event)"
      @add-encryption-key="emit('addEncryptionKey', $event)"
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

    <div v-if="encryptedPreviewUnavailable" :class="[$style.encryptedNoKey, 'alert', 'alert-warning']">
      <ShieldCheck :size="16" :stroke-width="2" aria-hidden="true" />
      <span>このファイルは暗号化されています。このブラウザに復号キーがないためプレビューできません。ダウンロードは暗号化されたまま保存されます。</span>
    </div>
    <div v-else-if="canShowPreview && isImage" :class="[$style.imagePreview, exifItems.length > 0 ? $style.imagePreviewWithExif : null]">
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

    <p v-if="decryptedPreviewUrl && canShowPreview" :class="$style.decryptedCaption">
      <ShieldCheck :size="13" :stroke-width="2" aria-hidden="true" />
      このブラウザに保存されたキーで復号して表示しています
    </p>

    <div v-if="visibleDownloadError" class="alert alert-error mt-3">{{ visibleDownloadError }}</div>

    <ConfirmDialog
      v-model:open="encryptedDownloadConfirmOpen"
      title="復号キーがありません"
      message="このファイルは暗号化されています。このブラウザに復号キーがないため、暗号化されたままダウンロードされます。それでもダウンロードしますか？"
      confirm-label="ダウンロード"
      cancel-label="キャンセル"
      @confirm="confirmEncryptedDownload"
    />
    <StorageQuotaDialog
      :open="quotaDialog != null"
      :required-bytes="quotaDialog?.requiredBytes ?? 0"
      :available-bytes="quotaDialog?.availableBytes ?? 0"
      @update:open="quotaDialog = null"
    />
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

.encryptedNoKey {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 16px;

  svg {
    flex-shrink: 0;
    margin-top: 2px;
  }
}

.decryptedCaption {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  color: var(--color-text-muted);
  font-size: 0.8rem;
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
