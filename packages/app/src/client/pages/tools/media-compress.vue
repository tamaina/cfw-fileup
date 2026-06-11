<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Download, Image as ImageIcon, LoaderCircle, Settings, Video } from '@lucide/vue';
import MediaConversionSettingsDialog from '@/components/MediaConversionSettingsDialog.vue';
import MediaConversionSettingsSummary from '@/components/MediaConversionSettingsSummary.vue';
import { formatBytes } from '@/utils/byte-size';
import {
	cloneMediaConversionSettings,
	checkMediaVideoInputSupport,
	defaultMediaConversionSettings,
	normalizeMediaImageConversionSettingsForBrowserSupport,
	replacePathExtension,
	supportedAudioEncodeVariants,
	supportedVideoEncodeVariants,
	type MediaAudioEncodeVariant,
	type MediaImageAvifVariant,
	type MediaConversionSettings,
	type MediaVideoEncodeVariant,
} from '@/utils/media-conversion';
import { runMediaConversionWorker, terminateMediaConversionWorker } from '@/store/media-conversion-worker';
import type { MediaConversionWorkerRequest } from '@/workers/media-conversion.worker';
import type { UploadResolvedEntry } from '@/workers/upload-worker-types';

type MediaStatus = 'queued' | 'processing' | 'done' | 'skipped' | 'error';
type MediaKind = 'image' | 'video' | 'unsupported';

type MediaItem = {
	id: string;
	file: File;
	kind: MediaKind;
	outputName: string;
	status: MediaStatus;
	error: string;
	progress: number;
	outputBlob: Blob | null;
	outputUrl: string;
	opfsName: string;
	supportChecking: boolean;
};

const settings = ref<MediaConversionSettings>(defaultMediaConversionSettings());
const settingsDialogOpen = ref(false);
const canEncodeWebp = ref(true);
const canEncodeAvif = ref(true);
const avifVariants = ref<MediaImageAvifVariant[]>([{ chromaSubsampling: '444', bitDepth: 8 }]);
const videoEncodeVariants = ref<MediaVideoEncodeVariant[]>([]);
const audioEncodeVariants = ref<MediaAudioEncodeVariant[]>([]);
const items = ref<MediaItem[]>([]);
const isConverting = ref(false);
const selectionError = ref('');
const isDragOver = ref(false);

const supported = computed(() => (
	typeof OffscreenCanvas !== 'undefined'
	&& typeof createImageBitmap !== 'undefined'
));
const readyItems = computed(() => items.value.filter(item => item.status !== 'skipped' && !item.supportChecking));
const doneItems = computed(() => items.value.filter(item => item.status === 'done' && item.outputUrl));
const canConvert = computed(() => supported.value && readyItems.value.length > 0 && !isConverting.value);

function mediaKind(file: File): MediaKind {
	if (file.type.startsWith('image/')) return 'image';
	if (file.type.startsWith('video/')) return 'video';
	return 'unsupported';
}

function outputName(file: File, kind: MediaKind): string {
	const name = file.name.replace(/\.[^/.]+$/, '') || 'media';
	if (kind === 'image') return replacePathExtension(name, settings.value.image.outputMime);
	if (kind === 'video') return replacePathExtension(name, settings.value.video.outputMime);
	return file.name;
}

function createItem(file: File): MediaItem {
	const kind = mediaKind(file);
	return {
		id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
		file,
		kind,
		outputName: outputName(file, kind),
		status: kind === 'unsupported' ? 'skipped' : 'queued',
		error: kind === 'unsupported' ? '画像または動画ファイルではありません。' : '',
		progress: 0,
		outputBlob: null,
		outputUrl: '',
		opfsName: '',
		supportChecking: kind === 'video',
	};
}

function revokeItem(item: MediaItem): void {
	if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
	item.outputUrl = '';
	if (item.opfsName) void deleteFromOpfs(item.opfsName);
	item.opfsName = '';
}

function clearItems(): void {
	for (const item of items.value) revokeItem(item);
	items.value = [];
	selectionError.value = '';
}

function addFiles(fileList: FileList | File[]): void {
	selectionError.value = '';
	const files = Array.from(fileList);
	if (files.length === 0) return;
	const startIndex = items.value.length;
	items.value.push(...files.map(createItem));
	for (const item of items.value.slice(startIndex)) void checkItemVideoSupport(item);
}

async function checkItemVideoSupport(item: MediaItem): Promise<void> {
	if (item.kind !== 'video') return;
	item.supportChecking = true;
	const support = await checkMediaVideoInputSupport(item.file);
	item.supportChecking = false;
	if (support.supported) return;
	if (item.status === 'processing' || item.status === 'done') return;
	item.status = 'skipped';
	item.error = support.reason;
}

function handleFileInputChange(event: Event): void {
	const input = event.target as HTMLInputElement;
	if (input.files) addFiles(input.files);
	input.value = '';
}

function handleDrop(event: DragEvent): void {
	isDragOver.value = false;
	if (!event.dataTransfer?.files) return;
	addFiles(event.dataTransfer.files);
}

function itemConversionKind(kind: MediaKind): 'image' | 'video' {
	return kind === 'video' ? 'video' : 'image';
}

function createMediaConversionWorkerRequest(targetItems: readonly MediaItem[]): MediaConversionWorkerRequest {
	const currentSettings = cloneMediaConversionSettings(settings.value);
	return {
		id: crypto.randomUUID(),
		files: targetItems.map((item, index) => ({
			index,
			conversionKind: itemConversionKind(item.kind),
			originalPath: item.file.name,
			path: item.file.name,
			file: item.file,
		})),
		imageCompression: { ...currentSettings.image, enabled: true },
		videoConversion: { ...currentSettings.video, enabled: true },
	};
}

function runMediaConversionForItems(targetItems: readonly MediaItem[]): Promise<void> {
	const request = createMediaConversionWorkerRequest(targetItems);
	return runMediaConversionWorker(request, {
		title: '画像・動画縮小ツール',
		onProgress: (progress) => {
			const item = targetItems[progress.fileIndex];
			if (!item) return;
			item.status = 'processing';
			item.progress = progress.videoProgress != null ? Math.round(progress.videoProgress * 100) : item.progress;
		},
		onConvertedEntry: async (entry) => {
			const item = targetItems[entry.originalIndex];
			if (!item) return;
			await handleSingleConvertedEntry(item, entry).catch((err) => {
				item.status = 'error';
				item.error = err instanceof Error ? err.message : String(err);
			});
		},
		onFallbackEntry: (entry, error) => {
			const item = targetItems[entry.originalIndex];
			if (!item) return;
			item.status = 'error';
			item.error = error;
		},
	});
}

async function handleSingleConvertedEntry(item: MediaItem, entry: UploadResolvedEntry): Promise<void> {
	const file = await loadOpfsFile(entry);
	revokeItem(item);
	item.outputBlob = file;
	item.outputName = file.name;
	item.outputUrl = URL.createObjectURL(file);
	item.opfsName = entry.source.kind === 'opfs' ? entry.source.opfsName : '';
	item.progress = 100;
	item.status = 'done';
}

async function loadOpfsFile(entry: UploadResolvedEntry): Promise<File> {
	if (entry.source.kind !== 'opfs') return entry.source.file;
	const root = await navigator.storage.getDirectory();
	const handle = await root.getFileHandle(entry.source.opfsName);
	const file = await handle.getFile();
	return new File([file], entry.name, { type: entry.type, lastModified: entry.lastModified });
}

async function deleteFromOpfs(name: string): Promise<void> {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(name).catch(() => {});
}

async function convertAll(): Promise<void> {
	if (!supported.value) {
		selectionError.value = 'このブラウザではメディア縮小を利用できません。';
		return;
	}
	const targetItems = [...readyItems.value];
	isConverting.value = true;
	selectionError.value = '';
	try {
		for (const item of targetItems) {
			item.status = 'processing';
			item.error = '';
			item.progress = 0;
			revokeItem(item);
			item.outputBlob = null;
		}
		await runMediaConversionForItems(targetItems);
	} catch (err) {
		selectionError.value = err instanceof Error ? err.message : String(err);
	} finally {
		isConverting.value = false;
	}
}

function reductionPercent(item: MediaItem): string {
	if (!item.outputBlob || item.file.size <= 0) return '-';
	const value = Math.round((1 - item.outputBlob.size / item.file.size) * 100);
	return `${value}%`;
}

function statusLabel(item: MediaItem): string {
	if (item.supportChecking) return '検査中';
	if (item.status === 'queued') return '変換可能';
	if (item.status === 'processing') return item.kind === 'video' && item.progress > 0 ? `変換中 ${item.progress}%` : '変換中';
	if (item.status === 'done') return '完了';
	if (item.status === 'skipped') return '対象外';
	return 'エラー';
}

function kindLabel(kind: MediaKind): string {
	if (kind === 'image') return '画像';
	if (kind === 'video') return '動画';
	return '対象外';
}

onMounted(async () => {
	const browserSupport = await normalizeMediaImageConversionSettingsForBrowserSupport(settings.value.image);
	canEncodeWebp.value = browserSupport.support.canEncodeWebp;
	canEncodeAvif.value = browserSupport.support.canEncodeAvif;
	avifVariants.value = browserSupport.support.avifVariants;
	videoEncodeVariants.value = await supportedVideoEncodeVariants();
	audioEncodeVariants.value = await supportedAudioEncodeVariants();
	settings.value = { ...settings.value, image: browserSupport.settings };
});

onBeforeUnmount(() => {
	terminateMediaConversionWorker();
	clearItems();
});
</script>

<template>
  <main :class="$style.page">
    <section :class="$style.header">
      <div>
        <p :class="$style.kicker">Tools</p>
        <h1>画像・動画縮小ツール</h1>
        <p :class="$style.lead">画像と動画をブラウザ内で縮小して、ローカルに保存できます。</p>
      </div>
    </section>

    <section class="card" :class="$style.toolCard">
      <div :class="$style.cardHeader">
        <div>
          <p>動画変換はブラウザのWebCodecs対応状況に依存します。</p>
        </div>
      </div>

      <div v-if="!supported" class="alert alert-warning mb-4">
        このブラウザではメディア縮小を利用できません。
      </div>
      <div v-if="selectionError" class="alert alert-error mb-4">{{ selectionError }}</div>

      <label
        :class="[$style.dropZone, isDragOver ? $style.dropZoneActive : null]"
        @dragover.prevent="isDragOver = true"
        @dragleave.prevent="isDragOver = false"
        @drop.prevent="handleDrop"
      >
        <span :class="$style.dropIcons">
          <ImageIcon :size="28" :stroke-width="2" />
          <Video :size="28" :stroke-width="2" />
        </span>
        <span>画像または動画を選択</span>
        <input type="file" accept="image/*,video/*" multiple :class="$style.fileInput" @change="handleFileInputChange">
      </label>

      <MediaConversionSettingsSummary :settings="settings" force-enable />

      <div :class="$style.actions">
        <button type="button" class="btn btn-secondary" @click="settingsDialogOpen = true">
          <Settings :size="16" :stroke-width="2" />
          設定
        </button>
        <button type="button" class="btn btn-primary" :disabled="!canConvert" @click="convertAll">
          <LoaderCircle v-if="isConverting" :size="16" :stroke-width="2" :class="$style.spin" />
          <ImageIcon v-else :size="16" :stroke-width="2" />
          変換
        </button>
        <button type="button" class="btn btn-secondary" :disabled="items.length === 0 || isConverting" @click="clearItems">
          クリア
        </button>
      </div>

      <div v-if="items.length > 0" :class="$style.resultTableWrap">
        <table :class="$style.resultTable">
          <thead>
            <tr>
              <th>保存</th>
              <th>ファイル</th>
              <th>種類</th>
              <th>状態</th>
              <th>元サイズ</th>
              <th>出力サイズ</th>
              <th>削減率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td>
                <a
                  v-if="item.outputUrl"
                  class="btn btn-secondary btn-icon"
                  :href="item.outputUrl"
                  :download="item.outputName"
                  :aria-label="`${item.outputName}を保存`"
                >
                  <Download :size="16" :stroke-width="2" />
                </a>
                <span v-else>-</span>
              </td>
              <td>
                <div :class="$style.fileName">{{ item.file.name }}</div>
                <div v-if="item.error" :class="$style.errorText">{{ item.error }}</div>
              </td>
              <td>{{ kindLabel(item.kind) }}</td>
              <td><span :class="['badge', item.status === 'done' ? 'badge-success' : item.status === 'error' ? 'badge-danger' : 'badge-muted']">{{ statusLabel(item) }}</span></td>
              <td>{{ formatBytes(item.file.size) }}</td>
              <td>{{ item.outputBlob ? formatBytes(item.outputBlob.size) : '-' }}</td>
              <td>{{ reductionPercent(item) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="doneItems.length > 0" :class="$style.doneSummary">
        {{ doneItems.length }} 件の変換が完了しました。
      </div>
    </section>

    <MediaConversionSettingsDialog
      v-model:open="settingsDialogOpen"
      v-model="settings"
      force-enable
      :can-encode-webp="canEncodeWebp"
      :can-encode-avif="canEncodeAvif"
      :avif-variants="avifVariants"
      :video-encode-variants="videoEncodeVariants"
      :audio-encode-variants="audioEncodeVariants"
      allow-hls-video
    />
  </main>
</template>

<style module lang="scss">
.page {
  display: grid;
  gap: 24px;
}

.header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.kicker {
  margin: 0 0 4px;
  color: var(--color-text-muted);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.lead {
  max-width: 640px;
  color: var(--color-text-muted);
}

.toolCard {
  display: grid;
  gap: 18px;
}

.cardHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.cardHeader p {
  margin: 0;
  color: var(--color-text-muted);
}

.dropZone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 160px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-text-muted);
  background: var(--color-bg);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.dropZone:hover,
.dropZoneActive {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 8%, var(--color-surface));
}

.dropIcons,
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.actions {
  align-items: center;
}

.actions > :global(.btn-secondary:last-child) {
  margin-left: auto;
}

.fileInput {
  display: none;
}

.spin {
  animation: spin 0.9s linear infinite;
}

.resultTableWrap {
  overflow-x: auto;
}

.resultTable {
  width: 100%;
  min-width: 820px;
  border-collapse: collapse;
}

.resultTable th,
.resultTable td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  vertical-align: middle;
}

.resultTable th {
  color: var(--color-text-muted);
  font-size: 0.78rem;
  font-weight: 600;
}

.fileName {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.errorText {
  color: var(--color-danger);
  font-size: 0.78rem;
}

.doneSummary {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .cardHeader {
    flex-direction: column;
  }
}
</style>
