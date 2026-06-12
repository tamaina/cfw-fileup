<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { Dialog } from '@vuetify/v0';
import { Camera, ImageUp, Trash2 } from '@lucide/vue';
import { createHlsPosterFile } from '@/utils/media-conversion';
import type { HlsEntryUploadSettings } from '@/utils/upload-tree';

const props = defineProps<{
	open: boolean;
	/** HLS 変換対象の元動画ファイル（フレームキャプチャ用） */
	file: File | null;
	entryName: string;
	modelValue: HlsEntryUploadSettings | undefined;
}>();

const emit = defineEmits<{
	(event: 'update:open', value: boolean): void;
	(event: 'update:modelValue', value: HlsEntryUploadSettings): void;
}>();

const title = ref('');
const poster = ref<File | null>(null);
const posterPreviewUrl = ref('');
const videoUrl = ref('');
const posterError = ref('');
const posterProcessing = ref(false);
const videoElement = ref<HTMLVideoElement | null>(null);
const imageInputElement = ref<HTMLInputElement | null>(null);

watch(() => props.open, (open) => {
	if (!open) return;
	title.value = props.modelValue?.title ?? '';
	posterError.value = '';
	setPoster(props.modelValue?.poster ?? null);
	revokeVideoUrl();
	if (props.file) videoUrl.value = URL.createObjectURL(props.file);
});

function setPoster(file: File | null): void {
	if (posterPreviewUrl.value) URL.revokeObjectURL(posterPreviewUrl.value);
	poster.value = file;
	posterPreviewUrl.value = file ? URL.createObjectURL(file) : '';
}

function revokeVideoUrl(): void {
	if (!videoUrl.value) return;
	URL.revokeObjectURL(videoUrl.value);
	videoUrl.value = '';
}

async function captureFrame(): Promise<void> {
	const video = videoElement.value;
	if (!video || video.readyState < 2 || video.videoWidth === 0) {
		posterError.value = '動画のフレームを取得できません。再生位置を動かしてから再度お試しください。';
		return;
	}
	posterError.value = '';
	posterProcessing.value = true;
	try {
		const canvas = document.createElement('canvas');
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas を利用できません。');
		context.drawImage(video, 0, 0);
		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(result => result ? resolve(result) : reject(new Error('フレームの画像化に失敗しました。')), 'image/jpeg', 0.95);
		});
		setPoster(await createHlsPosterFile(blob));
	} catch (err) {
		posterError.value = err instanceof Error ? err.message : String(err);
	} finally {
		posterProcessing.value = false;
	}
}

async function handleImageInputChange(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (!file) return;
	posterError.value = '';
	posterProcessing.value = true;
	try {
		setPoster(await createHlsPosterFile(file));
	} catch (err) {
		posterError.value = err instanceof Error ? err.message : String(err);
	} finally {
		posterProcessing.value = false;
	}
}

function clearPoster(): void {
	setPoster(null);
}

function updateOpen(value: boolean): void {
	if (value) {
		emit('update:open', true);
		return;
	}
	close();
}

function close(): void {
	const trimmedTitle = title.value.trim();
	emit('update:modelValue', {
		title: trimmedTitle === '' ? undefined : trimmedTitle,
		poster: poster.value ?? undefined,
	});
	revokeVideoUrl();
	emit('update:open', false);
}

onBeforeUnmount(() => {
	revokeVideoUrl();
	if (posterPreviewUrl.value) URL.revokeObjectURL(posterPreviewUrl.value);
});
</script>

<template>
  <Dialog.Root :model-value="open" @update:model-value="updateOpen">
    <Dialog.Content :class="$style.dialog">
      <div :class="$style.inner">
        <div :class="$style.header">
          <Dialog.Title :class="$style.title">HLS設定</Dialog.Title>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="閉じる" @click="close">✕</button>
        </div>
        <p :class="$style.description">{{ entryName }} のタイトルとポスター画像を tar / プレイリストに埋め込みます。</p>

        <section :class="$style.section">
          <label class="form-group">
            <span class="form-label">タイトル</span>
            <input v-model="title" class="form-input" type="text" placeholder="動画のタイトル">
          </label>
        </section>

        <section :class="$style.section">
          <h2 :class="$style.sectionTitle">ポスター画像</h2>
          <div v-if="videoUrl" :class="$style.captureArea">
            <video
              ref="videoElement"
              :src="videoUrl"
              :class="$style.video"
              controls
              muted
              playsinline
              preload="metadata"
            />
            <p :class="$style.note">ポスターにしたい場面で一時停止して「この場面をポスターにする」を押してください。</p>
          </div>
          <div :class="$style.posterActions">
            <button type="button" class="btn btn-secondary" :disabled="!videoUrl || posterProcessing" @click="captureFrame">
              <Camera :size="16" :stroke-width="2" aria-hidden="true" />
              この場面をポスターにする
            </button>
            <button type="button" class="btn btn-secondary" :disabled="posterProcessing" @click="imageInputElement?.click()">
              <ImageUp :size="16" :stroke-width="2" aria-hidden="true" />
              画像ファイルを選択
            </button>
            <input ref="imageInputElement" type="file" accept="image/*" hidden @change="handleImageInputChange">
          </div>
          <div v-if="posterError" class="alert alert-error">{{ posterError }}</div>
          <div v-if="posterProcessing" class="page-loading"><span class="spinner" />ポスターを作成中...</div>
          <div v-else-if="posterPreviewUrl" :class="$style.posterPreview">
            <img :src="posterPreviewUrl" :class="$style.posterImage" alt="ポスタープレビュー">
            <button type="button" class="btn btn-ghost-danger" @click="clearPoster">
              <Trash2 :size="16" :stroke-width="2" aria-hidden="true" />
              ポスターを削除
            </button>
          </div>
          <p v-else :class="$style.note">ポスター画像は未設定です。</p>
        </section>

        <div :class="$style.actions">
          <button type="button" class="btn btn-primary" @click="close">完了</button>
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Root>
</template>

<style module lang="scss">
.dialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  width: min(560px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.inner {
  display: grid;
  gap: 18px;
  padding: 24px;
}

.header,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.actions {
  justify-content: flex-end;
}

.title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
}

.description {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  word-break: break-all;
}

.section {
  display: grid;
  gap: 12px;
}

.sectionTitle {
  margin: 0;
  font-size: 1rem;
}

.captureArea {
  display: grid;
  gap: 8px;
}

.video {
  width: 100%;
  max-height: 280px;
  border-radius: var(--radius-lg);
  background: #000;
}

.posterActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.posterPreview {
  display: grid;
  gap: 8px;
  justify-items: start;
}

.posterImage {
  width: min(320px, 100%);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: #000;
}

.note {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}
</style>
