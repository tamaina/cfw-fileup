<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Dialog } from '@vuetify/v0';
import { AudioLines, BadgeInfo, Clapperboard, FileType, Film, Gauge, MoveHorizontal, MoveVertical, Palette, ScanLine, Sparkles } from '@lucide/vue';
import {
	type AudioCodec,
	defaultAudioCodecForOutput,
	defaultVideoCodecForOutput,
	mediaAudioCodecOptions,
	mediaVideoCodecOptions,
	type MediaImageAvifBitDepth,
	type MediaImageAvifChromaSubsampling,
	type MediaImageAvifVariant,
	type MediaConversionSettings,
	type MediaVideoOutputMime,
	type VideoCodec,
	cloneMediaConversionSettings,
} from '@/utils/media-conversion';

const props = withDefaults(defineProps<{
	open: boolean;
	modelValue: MediaConversionSettings;
	enableImage?: boolean;
	enableVideo?: boolean;
	forceEnable?: boolean;
	canEncodeWebp?: boolean;
	canEncodeAvif?: boolean;
	avifVariants?: MediaImageAvifVariant[];
}>(), {
	enableImage: true,
	enableVideo: true,
	forceEnable: false,
	canEncodeWebp: true,
	canEncodeAvif: true,
	avifVariants: () => [{ chromaSubsampling: '444', bitDepth: 8 }],
});

const emit = defineEmits<{
	'update:open': [value: boolean];
	'update:modelValue': [value: MediaConversionSettings];
}>();

const draftSettings = ref<MediaConversionSettings>(cloneMediaConversionSettings(props.modelValue));
const openedSettings = ref<MediaConversionSettings>(cloneMediaConversionSettings(props.modelValue));

watch(() => props.open, (open) => {
	if (open) {
		draftSettings.value = cloneMediaConversionSettings(props.modelValue);
		openedSettings.value = cloneMediaConversionSettings(props.modelValue);
	}
});

watch(() => props.modelValue, (value) => {
	if (!props.open) {
		draftSettings.value = cloneMediaConversionSettings(value);
		openedSettings.value = cloneMediaConversionSettings(value);
	}
});

const imageEnabled = computed({
	get: () => props.forceEnable || draftSettings.value.image.enabled,
	set: enabled => {
		draftSettings.value = { ...draftSettings.value, image: { ...draftSettings.value.image, enabled } };
	},
});
const videoEnabled = computed({
	get: () => props.forceEnable || draftSettings.value.video.enabled,
	set: enabled => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, enabled } };
	},
});
const canEditImageSettings = computed(() => props.enableImage && imageEnabled.value);
const canEditVideoSettings = computed(() => props.enableVideo && videoEnabled.value);
const imageOutputMime = computed({
	get: () => draftSettings.value.image.outputMime,
	set: outputMime => {
		draftSettings.value = { ...draftSettings.value, image: { ...draftSettings.value.image, outputMime } };
	},
});
const imageQuality = computed({
	get: () => Math.round(draftSettings.value.image.quality * 100),
	set: quality => {
		draftSettings.value = { ...draftSettings.value, image: { ...draftSettings.value.image, quality: quality / 100 } };
	},
});
const imageMaxWidth = computed({
	get: () => draftSettings.value.image.maxWidth,
	set: maxWidth => {
		draftSettings.value = { ...draftSettings.value, image: { ...draftSettings.value.image, maxWidth } };
	},
});
const imageMaxHeight = computed({
	get: () => draftSettings.value.image.maxHeight,
	set: maxHeight => {
		draftSettings.value = { ...draftSettings.value, image: { ...draftSettings.value.image, maxHeight } };
	},
});
const imageExif = computed({
	get: () => draftSettings.value.image.exif,
	set: exif => {
		draftSettings.value = { ...draftSettings.value, image: { ...draftSettings.value.image, exif } };
	},
});
const imageAnimation = computed({
	get: () => draftSettings.value.image.animation,
	set: animation => {
		draftSettings.value = { ...draftSettings.value, image: { ...draftSettings.value.image, animation } };
	},
});
const imageAvifBitDepth = computed({
	get: () => draftSettings.value.image.avifBitDepth,
	set: avifBitDepth => {
		const currentChromaSubsampling = draftSettings.value.image.avifChromaSubsampling;
		const chromaSubsampling = props.avifVariants.some(variant => variant.bitDepth === avifBitDepth && variant.chromaSubsampling === currentChromaSubsampling)
			? currentChromaSubsampling
			: props.avifVariants.find(variant => variant.bitDepth === avifBitDepth)?.chromaSubsampling ?? currentChromaSubsampling;
		draftSettings.value = {
			...draftSettings.value,
			image: { ...draftSettings.value.image, avifBitDepth, avifChromaSubsampling: chromaSubsampling },
		};
	},
});
const imageAvifChromaSubsampling = computed({
	get: () => draftSettings.value.image.avifChromaSubsampling,
	set: avifChromaSubsampling => {
		const currentBitDepth = draftSettings.value.image.avifBitDepth;
		const bitDepth = props.avifVariants.some(variant => variant.chromaSubsampling === avifChromaSubsampling && variant.bitDepth === currentBitDepth)
			? currentBitDepth
			: props.avifVariants.find(variant => variant.chromaSubsampling === avifChromaSubsampling)?.bitDepth ?? currentBitDepth;
		draftSettings.value = {
			...draftSettings.value,
			image: { ...draftSettings.value.image, avifBitDepth: bitDepth, avifChromaSubsampling },
		};
	},
});
const videoOutputMime = computed({
	get: () => draftSettings.value.video.outputMime,
	set: outputMime => {
		const normalizedOutputMime = outputMime as MediaVideoOutputMime;
		const currentVideoCodec = draftSettings.value.video.videoCodec;
		const currentAudioCodec = draftSettings.value.video.audioCodec;
		draftSettings.value = {
			...draftSettings.value,
			video: {
				...draftSettings.value.video,
				outputMime: normalizedOutputMime,
				videoCodec: (mediaVideoCodecOptions[normalizedOutputMime] as readonly VideoCodec[]).includes(currentVideoCodec)
					? currentVideoCodec
					: defaultVideoCodecForOutput(normalizedOutputMime),
				audioCodec: (mediaAudioCodecOptions[normalizedOutputMime] as readonly AudioCodec[]).includes(currentAudioCodec)
					? currentAudioCodec
					: defaultAudioCodecForOutput(normalizedOutputMime),
			},
		};
	},
});
const videoCodec = computed({
	get: () => draftSettings.value.video.videoCodec,
	set: videoCodec => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, videoCodec } };
	},
});
const audioCodec = computed({
	get: () => draftSettings.value.video.audioCodec,
	set: audioCodec => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, audioCodec } };
	},
});
const videoBitrate = computed({
	get: () => draftSettings.value.video.videoBitrate / 1_000_000,
	set: videoMbps => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, videoBitrate: Math.round(videoMbps * 1_000_000) } };
	},
});
const audioBitrate = computed({
	get: () => draftSettings.value.video.audioBitrate / 1_000,
	set: audioKbps => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, audioBitrate: Math.round(audioKbps * 1_000) } };
	},
});
const videoMaxWidth = computed({
	get: () => draftSettings.value.video.maxWidth,
	set: maxWidth => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, maxWidth } };
	},
});
const videoMaxHeight = computed({
	get: () => draftSettings.value.video.maxHeight,
	set: maxHeight => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, maxHeight } };
	},
});
const selectableVideoCodecs = computed(() => mediaVideoCodecOptions[draftSettings.value.video.outputMime]);
const selectableAudioCodecs = computed(() => mediaAudioCodecOptions[draftSettings.value.video.outputMime]);
const selectableAvifBitDepths = computed(() => uniqueAvifVariantValues(
	props.avifVariants
		.filter(variant => variant.chromaSubsampling === draftSettings.value.image.avifChromaSubsampling)
		.map(variant => variant.bitDepth),
));
const selectableAvifChromaSubsamplings = computed(() => uniqueAvifVariantValues(
	props.avifVariants
		.filter(variant => variant.bitDepth === draftSettings.value.image.avifBitDepth)
		.map(variant => variant.chromaSubsampling),
));

function updateOpen(value: boolean): void {
	if (value) {
		emit('update:open', true);
		return;
	}
	close();
}

function close(): void {
	emit('update:modelValue', cloneMediaConversionSettings(draftSettings.value));
	emit('update:open', false);
}

function restoreOpenedSettings(): void {
	draftSettings.value = cloneMediaConversionSettings(openedSettings.value);
}

function uniqueAvifVariantValues<T extends MediaImageAvifBitDepth | MediaImageAvifChromaSubsampling>(values: T[]): T[] {
	return [...new Set(values)];
}

function nullableNumber(event: Event): number | null {
	const value = (event.target as HTMLInputElement).value;
	return value === '' ? null : Number(value);
}
</script>

<template>
  <Dialog.Root :model-value="open" @update:model-value="updateOpen">
    <Dialog.Content :class="$style.dialog">
      <div :class="$style.inner">
        <div :class="$style.header">
          <Dialog.Title :class="$style.title">メディア縮小設定</Dialog.Title>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="閉じる" @click="close">✕</button>
        </div>

        <section :class="[$style.section, !canEditImageSettings ? $style.disabled : null]">
          <div :class="$style.sectionHeader">
            <h2>画像</h2>
            <label v-if="!forceEnable && enableImage" class="checkbox-label">
              <input v-model="imageEnabled" type="checkbox">
              <span>変換する</span>
            </label>
            <span v-else-if="!canEditImageSettings" class="badge badge-muted">無効</span>
          </div>
          <div :class="$style.grid">
            <label class="form-group">
              <span class="form-label" :class="$style.label"><FileType :size="14" :stroke-width="2" />出力形式</span>
              <select v-model="imageOutputMime" class="form-input" :disabled="!canEditImageSettings">
                <option value="image/webp" :disabled="!canEncodeWebp">WebP</option>
                <option value="image/jpeg">JPEG</option>
                <option value="image/avif" :disabled="!canEncodeAvif">AVIF</option>
              </select>
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><Sparkles :size="14" :stroke-width="2" />品質</span>
              <input v-model.number="imageQuality" class="form-input" type="number" min="10" max="100" step="5" :disabled="!canEditImageSettings">
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><MoveHorizontal :size="14" :stroke-width="2" />最大幅</span>
              <input v-model.number="imageMaxWidth" class="form-input" type="number" min="1" step="1" :disabled="!canEditImageSettings">
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><MoveVertical :size="14" :stroke-width="2" />最大高さ</span>
              <input v-model.number="imageMaxHeight" class="form-input" type="number" min="1" step="1" :disabled="!canEditImageSettings">
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><BadgeInfo :size="14" :stroke-width="2" />EXIF</span>
              <select v-model="imageExif" class="form-input" :disabled="!canEditImageSettings">
                <option value="drop-gps">GPSのみ削除</option>
                <option value="keep">維持</option>
                <option value="drop">削除</option>
              </select>
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><Film :size="14" :stroke-width="2" />アニメーション</span>
              <select v-model="imageAnimation" class="form-input" :disabled="!canEditImageSettings">
                <option value="preserve">維持</option>
                <option value="first-frame">先頭フレーム</option>
                <option value="error">エラーにする</option>
              </select>
            </label>
            <label v-if="imageOutputMime === 'image/avif'" class="form-group">
              <span class="form-label" :class="$style.label"><Palette :size="14" :stroke-width="2" />AVIF ビット深度</span>
              <select v-model.number="imageAvifBitDepth" class="form-input" :disabled="!canEditImageSettings || !canEncodeAvif">
                <option v-for="bitDepth in selectableAvifBitDepths" :key="bitDepth" :value="bitDepth">{{ bitDepth }} bit</option>
              </select>
            </label>
            <label v-if="imageOutputMime === 'image/avif'" class="form-group">
              <span class="form-label" :class="$style.label"><ScanLine :size="14" :stroke-width="2" />AVIF クロマサブサンプリング</span>
              <select v-model="imageAvifChromaSubsampling" class="form-input" :disabled="!canEditImageSettings || !canEncodeAvif">
                <option v-for="chromaSubsampling in selectableAvifChromaSubsamplings" :key="chromaSubsampling" :value="chromaSubsampling">YUV {{ chromaSubsampling }}</option>
              </select>
            </label>
          </div>
          <p v-if="!canEncodeWebp || !canEncodeAvif" :class="$style.note">
            非対応の画像形式はJPEGへフォールバックします。
          </p>
        </section>

        <section :class="[$style.section, !canEditVideoSettings ? $style.disabled : null]">
          <div :class="$style.sectionHeader">
            <h2>動画</h2>
            <label v-if="!forceEnable && enableVideo" class="checkbox-label">
              <input v-model="videoEnabled" type="checkbox">
              <span>変換する</span>
            </label>
            <span v-else-if="!canEditVideoSettings" class="badge badge-muted">無効</span>
          </div>
          <div :class="$style.grid">
            <label class="form-group">
              <span class="form-label" :class="$style.label"><FileType :size="14" :stroke-width="2" />出力形式</span>
              <select v-model="videoOutputMime" class="form-input" :disabled="!canEditVideoSettings">
                <option value="video/mp4">MP4</option>
                <option value="video/webm">WebM</option>
              </select>
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><Clapperboard :size="14" :stroke-width="2" />動画コーデック</span>
              <select v-model="videoCodec" class="form-input" :disabled="!canEditVideoSettings">
                <option v-for="codec in selectableVideoCodecs" :key="codec" :value="codec">{{ codec.toUpperCase() }}</option>
              </select>
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><AudioLines :size="14" :stroke-width="2" />音声コーデック</span>
              <select v-model="audioCodec" class="form-input" :disabled="!canEditVideoSettings">
                <option v-for="codec in selectableAudioCodecs" :key="codec" :value="codec">{{ codec.toUpperCase() }}</option>
              </select>
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><Gauge :size="14" :stroke-width="2" />映像ビットレート (Mbps)</span>
              <input v-model.number="videoBitrate" class="form-input" type="number" min="0.1" step="0.1" :disabled="!canEditVideoSettings">
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><Gauge :size="14" :stroke-width="2" />音声ビットレート (Kbps)</span>
              <input v-model.number="audioBitrate" class="form-input" type="number" min="32" step="16" :disabled="!canEditVideoSettings">
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><MoveHorizontal :size="14" :stroke-width="2" />最大幅</span>
              <input :value="videoMaxWidth ?? ''" class="form-input" type="number" min="1" step="1" placeholder="自動" :disabled="!canEditVideoSettings" @input="videoMaxWidth = nullableNumber($event)">
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><MoveVertical :size="14" :stroke-width="2" />最大高さ</span>
              <input :value="videoMaxHeight ?? ''" class="form-input" type="number" min="1" step="1" placeholder="自動" :disabled="!canEditVideoSettings" @input="videoMaxHeight = nullableNumber($event)">
            </label>
          </div>
        </section>

        <div :class="$style.actions">
          <button type="button" class="btn btn-secondary" @click="restoreOpenedSettings">戻す</button>
          <button type="button" class="btn btn-primary" @click="close">閉じる</button>
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
  width: min(720px, calc(100vw - 32px));
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
.sectionHeader,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
}

.section {
  display: grid;
  gap: 12px;
}

.sectionHeader h2 {
  margin: 0;
  font-size: 1rem;
}

.disabled {
  opacity: 0.62;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.label svg {
  color: var(--color-text-muted);
  flex: 0 0 auto;
}

.note {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.actions {
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
