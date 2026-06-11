<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Dialog } from '@vuetify/v0';
import { AudioLines, BadgeInfo, Clapperboard, FileType, Film, Gauge, MoveHorizontal, MoveVertical, Palette, ScanLine, Sparkles, SwatchBook, Timer } from '@lucide/vue';
import {
	type AudioCodec,
	defaultAudioCodecForOutput,
	defaultVideoCodecForOutput,
	HLS_PLAYLIST_MIME,
	isHlsVideoOutput,
	mediaAudioCodecOptions,
	mediaVideoCodecOptions,
	type MediaColorMetadataPolicy,
	type MediaHlsVariantSettings,
	type MediaImageAvifBitDepth,
	type MediaImageAvifChromaSubsampling,
	type MediaImageAvifVariant,
	type MediaAudioEncodeVariant,
	type MediaConversionSettings,
	type MediaVideoEncodeVariant,
	type MediaVideoRawBitDepth,
	type MediaVideoRawChromaSubsampling,
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
	allowHlsVideo?: boolean;
	avifVariants?: MediaImageAvifVariant[];
	videoEncodeVariants?: MediaVideoEncodeVariant[];
	audioEncodeVariants?: MediaAudioEncodeVariant[];
}>(), {
	enableImage: true,
	enableVideo: true,
	forceEnable: false,
	canEncodeWebp: true,
	canEncodeAvif: true,
	allowHlsVideo: false,
	avifVariants: () => [{ chromaSubsampling: '444', bitDepth: 8 }],
	videoEncodeVariants: () => [],
	audioEncodeVariants: () => [],
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
const imageColorMetadata = computed({
	get: () => draftSettings.value.image.colorMetadata ?? 'preserve',
	set: colorMetadata => {
		draftSettings.value = { ...draftSettings.value, image: { ...draftSettings.value.image, colorMetadata } };
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
const hlsSegmentDuration = computed({
	get: () => draftSettings.value.video.hlsSegmentDuration ?? 2,
	set: seconds => {
		if (!Number.isFinite(seconds) || seconds <= 0) return;
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, hlsSegmentDuration: Math.max(0.5, Math.round(seconds * 10) / 10) } };
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
const videoColorMetadata = computed({
	get: () => draftSettings.value.video.colorMetadata ?? 'preserve',
	set: colorMetadata => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, colorMetadata } };
	},
});
const videoRawBitDepth = computed({
	get: () => draftSettings.value.video.rawBitDepth ?? 'preserve',
	set: rawBitDepth => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, rawBitDepth } };
	},
});
const videoRawChromaSubsampling = computed({
	get: () => draftSettings.value.video.rawChromaSubsampling ?? 'preserve',
	set: rawChromaSubsampling => {
		draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, rawChromaSubsampling } };
	},
});
const selectableVideoCodecs = computed(() => {
	const codecs = mediaVideoCodecOptions[draftSettings.value.video.outputMime];
	if (props.videoEncodeVariants.length === 0) return codecs;
	const supportedCodecs = codecs.filter(codec => props.videoEncodeVariants.some(variant => variant.videoCodec === codec));
	return supportedCodecs.length > 0 ? supportedCodecs : codecs;
});
const selectableAudioCodecs = computed(() => {
	const codecs = mediaAudioCodecOptions[draftSettings.value.video.outputMime] as readonly AudioCodec[];
	if (props.audioEncodeVariants.length === 0) return codecs;
	const supportedCodecs = codecs.filter(codec => props.audioEncodeVariants.some(variant => variant.audioCodec === codec));
	return supportedCodecs.length > 0 ? supportedCodecs : codecs;
});
const isHlsDraftOutput = computed(() => isHlsVideoOutput(draftSettings.value.video.outputMime));
const hlsVariants = computed(() => draftSettings.value.video.hlsVariants);
const fallbackVideoRawBitDepths = [8] as const satisfies readonly Exclude<MediaVideoRawBitDepth, 'preserve'>[];
const fallbackVideoRawChromaSubsamplings = ['420'] as const satisfies readonly Exclude<MediaVideoRawChromaSubsampling, 'preserve'>[];
const selectableVideoRawBitDepths = computed(() => selectableRawBitDepthsFor(
	draftSettings.value.video.videoCodec,
	videoRawChromaSubsampling.value,
));
const selectableVideoRawChromaSubsamplings = computed(() => selectableRawChromaSubsamplingsFor(
	draftSettings.value.video.videoCodec,
	videoRawBitDepth.value,
));

watch([selectableVideoRawBitDepths, selectableVideoRawChromaSubsamplings], ([bitDepths, chromaSubsamplings]) => {
	if (videoRawBitDepth.value !== 'preserve' && !bitDepths.includes(videoRawBitDepth.value)) {
		videoRawBitDepth.value = 'preserve';
	}
	if (videoRawChromaSubsampling.value !== 'preserve' && !chromaSubsamplings.includes(videoRawChromaSubsampling.value)) {
		videoRawChromaSubsampling.value = 'preserve';
	}
});

watch(selectableVideoCodecs, (codecs) => {
	const fallbackCodec = codecs[0] ?? defaultVideoCodecForOutput(draftSettings.value.video.outputMime);
	const videoCodec = codecs.includes(draftSettings.value.video.videoCodec)
		? draftSettings.value.video.videoCodec
		: fallbackCodec;
	const hlsVariants = draftSettings.value.video.hlsVariants.map(variant => ({
		...variant,
		videoCodec: codecs.includes(variant.videoCodec) ? variant.videoCodec : fallbackCodec,
	}));
	if (videoCodec !== draftSettings.value.video.videoCodec || hlsVariants.some((variant, index) => variant.videoCodec !== draftSettings.value.video.hlsVariants[index]?.videoCodec)) {
		draftSettings.value = {
			...draftSettings.value,
			video: {
				...draftSettings.value.video,
				videoCodec,
				hlsVariants,
			},
		};
	}
}, { immediate: true });

watch(selectableAudioCodecs, (codecs) => {
	const fallbackCodec = codecs[0] ?? defaultAudioCodecForOutput(draftSettings.value.video.outputMime);
	if (codecs.includes(draftSettings.value.video.audioCodec)) return;
	draftSettings.value = {
		...draftSettings.value,
		video: {
			...draftSettings.value.video,
			audioCodec: fallbackCodec,
		},
	};
}, { immediate: true });

function updateHlsVariant(index: number, patch: Partial<MediaHlsVariantSettings>): void {
	const variants = hlsVariants.value.map((variant, i) => i === index ? { ...variant, ...patch } : variant);
	draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, hlsVariants: variants } };
}

function addHlsVariant(): void {
	const variants = hlsVariants.value;
	const last = variants.at(-1) ?? {
		videoCodec: defaultVideoCodecForOutput(HLS_PLAYLIST_MIME),
		videoBitrate: draftSettings.value.video.videoBitrate,
		maxWidth: draftSettings.value.video.maxWidth,
		maxHeight: draftSettings.value.video.maxHeight,
		colorMetadata: draftSettings.value.video.colorMetadata,
		rawBitDepth: draftSettings.value.video.rawBitDepth,
		rawChromaSubsampling: draftSettings.value.video.rawChromaSubsampling,
	};
	// 目安として一段下のレンディション（解像度 2/3・ビットレート半分）を生成する
	const next: MediaHlsVariantSettings = {
		...last,
		videoBitrate: Math.max(200_000, Math.round(last.videoBitrate / 2)),
		maxWidth: last.maxWidth != null ? Math.max(256, Math.round(last.maxWidth / 3) * 2) : null,
		maxHeight: last.maxHeight != null ? Math.max(144, Math.round(last.maxHeight / 3) * 2) : null,
	};
	draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, hlsVariants: [...variants, next] } };
}

function removeHlsVariant(index: number): void {
	if (hlsVariants.value.length <= 1) return;
	const variants = hlsVariants.value.filter((_, i) => i !== index);
	draftSettings.value = { ...draftSettings.value, video: { ...draftSettings.value.video, hlsVariants: variants } };
}

function hlsVariantCodecChanged(index: number, event: Event): void {
	const videoCodec = (event.target as HTMLSelectElement).value as VideoCodec;
	const variant = hlsVariants.value[index];
	updateHlsVariant(index, {
		videoCodec,
		rawBitDepth: supportedRawPair(videoCodec, variant.rawBitDepth, variant.rawChromaSubsampling)
			? variant.rawBitDepth
			: 'preserve',
		rawChromaSubsampling: supportedRawPair(videoCodec, variant.rawBitDepth, variant.rawChromaSubsampling)
			? variant.rawChromaSubsampling
			: 'preserve',
	});
}

function hlsVariantBitrateChanged(index: number, event: Event): void {
	const mbps = Number((event.target as HTMLInputElement).value);
	if (!Number.isFinite(mbps) || mbps <= 0) return;
	updateHlsVariant(index, { videoBitrate: Math.round(mbps * 1_000_000) });
}

function hlsVariantMaxWidthChanged(index: number, event: Event): void {
	updateHlsVariant(index, { maxWidth: nullableNumber(event) });
}

function hlsVariantMaxHeightChanged(index: number, event: Event): void {
	updateHlsVariant(index, { maxHeight: nullableNumber(event) });
}

function hlsVariantBitrateMbps(variant: MediaHlsVariantSettings): number {
	return Math.round(variant.videoBitrate / 10_000) / 100;
}

function hlsVariantColorMetadataChanged(index: number, event: Event): void {
	updateHlsVariant(index, { colorMetadata: (event.target as HTMLSelectElement).value as MediaColorMetadataPolicy });
}

function hlsVariantRawBitDepthChanged(index: number, event: Event): void {
	const rawBitDepth = selectBitDepthValue(event);
	const variant = hlsVariants.value[index];
	updateHlsVariant(index, {
		rawBitDepth,
		rawChromaSubsampling: supportedRawPair(variant.videoCodec, rawBitDepth, variant.rawChromaSubsampling)
			? variant.rawChromaSubsampling
			: 'preserve',
	});
}

function hlsVariantRawChromaSubsamplingChanged(index: number, event: Event): void {
	const rawChromaSubsampling = (event.target as HTMLSelectElement).value as MediaVideoRawChromaSubsampling;
	const variant = hlsVariants.value[index];
	updateHlsVariant(index, {
		rawBitDepth: supportedRawPair(variant.videoCodec, variant.rawBitDepth, rawChromaSubsampling)
			? variant.rawBitDepth
			: 'preserve',
		rawChromaSubsampling,
	});
}

function selectableRawBitDepthsFor(videoCodec: VideoCodec, chromaSubsampling: MediaVideoRawChromaSubsampling): Exclude<MediaVideoRawBitDepth, 'preserve'>[] {
	const variants = supportedRawVariantsFor(videoCodec)
		.filter(variant => chromaSubsampling === 'preserve' || variant.chromaSubsampling === chromaSubsampling)
		.map(variant => variant.bitDepth);
	return uniqueValues(variants.length > 0 ? variants : [...fallbackVideoRawBitDepths]);
}

function selectableRawChromaSubsamplingsFor(videoCodec: VideoCodec, bitDepth: MediaVideoRawBitDepth): Exclude<MediaVideoRawChromaSubsampling, 'preserve'>[] {
	const variants = supportedRawVariantsFor(videoCodec)
		.filter(variant => bitDepth === 'preserve' || variant.bitDepth === bitDepth)
		.map(variant => variant.chromaSubsampling);
	return uniqueValues(variants.length > 0 ? variants : [...fallbackVideoRawChromaSubsamplings]);
}

function supportedRawPair(videoCodec: VideoCodec, bitDepth: MediaVideoRawBitDepth, chromaSubsampling: MediaVideoRawChromaSubsampling): boolean {
	if (bitDepth === 'preserve' || chromaSubsampling === 'preserve') return true;
	return supportedRawVariantsFor(videoCodec).some(variant =>
		variant.bitDepth === bitDepth
		&& variant.chromaSubsampling === chromaSubsampling
	);
}

function supportedRawVariantsFor(videoCodec: VideoCodec): MediaVideoEncodeVariant[] {
	return props.videoEncodeVariants.filter(variant => variant.videoCodec === videoCodec);
}

function selectBitDepthValue(event: Event): MediaVideoRawBitDepth {
	const value = (event.target as HTMLSelectElement).value;
	return value === 'preserve' ? value : Number(value) as MediaVideoRawBitDepth;
}
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
	return uniqueValues(values);
}

function uniqueValues<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function colorMetadataLabel(policy: MediaColorMetadataPolicy): string {
	if (policy === 'canvas-sdr') return 'Canvas SDR';
	return '維持';
}

function rawChromaSubsamplingLabel(chromaSubsampling: MediaVideoRawChromaSubsampling): string {
	if (chromaSubsampling === 'preserve') return '維持';
	if (chromaSubsampling === '420') return '4:2:0';
	if (chromaSubsampling === '422') return '4:2:2';
	return '4:4:4';
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
            <label class="form-group">
              <span class="form-label" :class="$style.label"><SwatchBook :size="14" :stroke-width="2" />色メタデータ</span>
              <select v-model="imageColorMetadata" class="form-input" :disabled="!canEditImageSettings">
                <option value="preserve">{{ colorMetadataLabel('preserve') }}</option>
                <option value="canvas-sdr">{{ colorMetadataLabel('canvas-sdr') }}</option>
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
                <option v-if="allowHlsVideo" :value="HLS_PLAYLIST_MIME">HLS (tar)</option>
              </select>
            </label>
            <label v-if="!isHlsDraftOutput" class="form-group">
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
            <label v-if="!isHlsDraftOutput" class="form-group">
              <span class="form-label" :class="$style.label"><Gauge :size="14" :stroke-width="2" />映像ビットレート (Mbps)</span>
              <input v-model.number="videoBitrate" class="form-input" type="number" min="0.1" step="0.1" :disabled="!canEditVideoSettings">
            </label>
            <label class="form-group">
              <span class="form-label" :class="$style.label"><Gauge :size="14" :stroke-width="2" />音声ビットレート (Kbps)</span>
              <input v-model.number="audioBitrate" class="form-input" type="number" min="32" step="16" :disabled="!canEditVideoSettings">
            </label>
            <label v-if="isHlsDraftOutput" class="form-group">
              <span class="form-label" :class="$style.label"><Timer :size="14" :stroke-width="2" />セグメント長 (秒)</span>
              <input v-model.number="hlsSegmentDuration" class="form-input" type="number" min="0.5" step="0.5" :disabled="!canEditVideoSettings">
            </label>
            <label v-if="!isHlsDraftOutput" class="form-group">
              <span class="form-label" :class="$style.label"><MoveHorizontal :size="14" :stroke-width="2" />最大幅</span>
              <input :value="videoMaxWidth ?? ''" class="form-input" type="number" min="1" step="1" placeholder="自動" :disabled="!canEditVideoSettings" @input="videoMaxWidth = nullableNumber($event)">
            </label>
            <label v-if="!isHlsDraftOutput" class="form-group">
              <span class="form-label" :class="$style.label"><MoveVertical :size="14" :stroke-width="2" />最大高さ</span>
              <input :value="videoMaxHeight ?? ''" class="form-input" type="number" min="1" step="1" placeholder="自動" :disabled="!canEditVideoSettings" @input="videoMaxHeight = nullableNumber($event)">
            </label>
            <label v-if="!isHlsDraftOutput" class="form-group">
              <span class="form-label" :class="$style.label"><SwatchBook :size="14" :stroke-width="2" />色メタデータ</span>
              <select v-model="videoColorMetadata" class="form-input" :disabled="!canEditVideoSettings">
                <option value="preserve">{{ colorMetadataLabel('preserve') }}</option>
                <option value="canvas-sdr">{{ colorMetadataLabel('canvas-sdr') }}</option>
              </select>
            </label>
            <label v-if="!isHlsDraftOutput" class="form-group">
              <span class="form-label" :class="$style.label"><Palette :size="14" :stroke-width="2" />ビット深度</span>
              <select v-model="videoRawBitDepth" class="form-input" :disabled="!canEditVideoSettings">
                <option value="preserve">維持</option>
                <option v-for="bitDepth in selectableVideoRawBitDepths" :key="bitDepth" :value="bitDepth">{{ bitDepth }} bit</option>
              </select>
            </label>
            <label v-if="!isHlsDraftOutput" class="form-group">
              <span class="form-label" :class="$style.label"><ScanLine :size="14" :stroke-width="2" />クロマサブサンプリング</span>
              <select v-model="videoRawChromaSubsampling" class="form-input" :disabled="!canEditVideoSettings">
                <option value="preserve">{{ rawChromaSubsamplingLabel('preserve') }}</option>
                <option v-for="chromaSubsampling in selectableVideoRawChromaSubsamplings" :key="chromaSubsampling" :value="chromaSubsampling">{{ rawChromaSubsamplingLabel(chromaSubsampling) }}</option>
              </select>
            </label>
          </div>
          <div v-if="isHlsDraftOutput" :class="$style.variantList" data-testid="hls-variant-list">
            <div :class="$style.variantHeader">
              <span class="form-label" :class="$style.variantTitle"><Film :size="14" :stroke-width="2" />バリアント（画質の段階）</span>
              <button type="button" class="btn btn-secondary" :disabled="!canEditVideoSettings" @click="addHlsVariant">+ バリアントを追加</button>
            </div>
            <div
              v-for="(variant, index) in hlsVariants"
              :key="index"
              :class="$style.variantRow"
              data-testid="hls-variant-row"
            >
              <label :class="$style.variantField">
                <span :class="$style.variantLabel"><Clapperboard :size="12" :stroke-width="2" />コーデック</span>
                <select class="form-input" :value="variant.videoCodec" :disabled="!canEditVideoSettings" @change="hlsVariantCodecChanged(index, $event)">
                  <option v-for="codec in selectableVideoCodecs" :key="codec" :value="codec">{{ codec.toUpperCase() }}</option>
                </select>
              </label>
              <label :class="$style.variantField">
                <span :class="$style.variantLabel"><MoveHorizontal :size="12" :stroke-width="2" />最大幅</span>
                <input :value="variant.maxWidth ?? ''" class="form-input" type="number" min="1" step="1" placeholder="自動" :disabled="!canEditVideoSettings" @input="hlsVariantMaxWidthChanged(index, $event)">
              </label>
              <label :class="$style.variantField">
                <span :class="$style.variantLabel"><MoveVertical :size="12" :stroke-width="2" />最大高さ</span>
                <input :value="variant.maxHeight ?? ''" class="form-input" type="number" min="1" step="1" placeholder="自動" :disabled="!canEditVideoSettings" @input="hlsVariantMaxHeightChanged(index, $event)">
              </label>
              <label :class="$style.variantField">
                <span :class="$style.variantLabel"><Gauge :size="12" :stroke-width="2" />映像 (Mbps)</span>
                <input :value="hlsVariantBitrateMbps(variant)" class="form-input" type="number" min="0.1" step="0.1" :disabled="!canEditVideoSettings" @input="hlsVariantBitrateChanged(index, $event)">
              </label>
              <label :class="$style.variantField">
                <span :class="$style.variantLabel"><SwatchBook :size="12" :stroke-width="2" />色</span>
                <select class="form-input" :value="variant.colorMetadata" :disabled="!canEditVideoSettings" @change="hlsVariantColorMetadataChanged(index, $event)">
                  <option value="preserve">{{ colorMetadataLabel('preserve') }}</option>
                  <option value="canvas-sdr">{{ colorMetadataLabel('canvas-sdr') }}</option>
                </select>
              </label>
              <label :class="$style.variantField">
                <span :class="$style.variantLabel"><Palette :size="12" :stroke-width="2" />bit</span>
                <select class="form-input" :value="variant.rawBitDepth" :disabled="!canEditVideoSettings" @change="hlsVariantRawBitDepthChanged(index, $event)">
                  <option value="preserve">維持</option>
                  <option v-for="bitDepth in selectableRawBitDepthsFor(variant.videoCodec, variant.rawChromaSubsampling)" :key="bitDepth" :value="bitDepth">{{ bitDepth }} bit</option>
                </select>
              </label>
              <label :class="$style.variantField">
                <span :class="$style.variantLabel"><ScanLine :size="12" :stroke-width="2" />クロマ</span>
                <select class="form-input" :value="variant.rawChromaSubsampling" :disabled="!canEditVideoSettings" @change="hlsVariantRawChromaSubsamplingChanged(index, $event)">
                  <option value="preserve">{{ rawChromaSubsamplingLabel('preserve') }}</option>
                  <option v-for="chromaSubsampling in selectableRawChromaSubsamplingsFor(variant.videoCodec, variant.rawBitDepth)" :key="chromaSubsampling" :value="chromaSubsampling">{{ rawChromaSubsamplingLabel(chromaSubsampling) }}</option>
                </select>
              </label>
              <button
                type="button"
                class="btn btn-ghost-danger btn-icon"
                :class="$style.variantRemove"
                :disabled="!canEditVideoSettings || hlsVariants.length <= 1"
                :aria-label="`バリアント${index + 1}を削除`"
                @click="removeHlsVariant(index)"
              >✕</button>
            </div>
          </div>
          <p v-if="isHlsDraftOutput" :class="$style.note">
            HLS はプレイリストとセグメントのファイル群に変換されるため、tar にまとめてアップロードされます。視聴側は回線に応じてバリアントを自動で切り替えます。
          </p>
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

.variantList {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.variantHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.variantTitle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}

.variantTitle svg {
  color: var(--color-text-muted);
}

.variantRow {
  position: relative;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  align-items: end;
  border-top: 1px solid var(--color-border);
  padding-right: 38px;
  padding-top: 10px;
}

.variantHeader + .variantRow {
  border-top: none;
  padding-top: 0;
}

.variantField {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.variantLabel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.variantLabel svg {
  flex: 0 0 auto;
}

.variantRemove {
  position: absolute;
  top: 50%;
  right: 0;
  transform: translateY(-50%);
}

@media (max-width: 640px) {
  .variantRow {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
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
