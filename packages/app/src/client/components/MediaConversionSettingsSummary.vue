<script setup lang="ts">
import { computed } from 'vue';
import { AudioLines, BadgeInfo, Clapperboard, Maximize2, Palette, ScanLine, Sparkles, SwatchBook, Timer, X } from '@lucide/vue';
import { formatKbps, formatMbps, isHlsVideoOutput, type MediaColorMetadataPolicy, type MediaConversionSettings, type MediaHlsVariantSettings, type MediaVideoRawChromaSubsampling } from '@/utils/media-conversion';

const props = withDefaults(defineProps<{
	settings: MediaConversionSettings;
	forceEnable?: boolean;
}>(), {
	forceEnable: false,
});

const imageOutputLabel = computed(() => props.settings.image.outputMime.replace('image/', '').toUpperCase());
const isHlsVideo = computed(() => isHlsVideoOutput(props.settings.video.outputMime));
const videoOutputLabel = computed(() => isHlsVideo.value ? 'HLS' : props.settings.video.outputMime.replace('video/', '').toUpperCase());
const hlsVariants = computed(() => props.settings.video.hlsVariants ?? []);

function hlsVariantLabel(variant: MediaHlsVariantSettings): string {
	const size = variant.maxHeight != null
		? `${variant.maxHeight}p`
		: variant.maxWidth != null
			? `幅${variant.maxWidth}`
			: '自動サイズ';
	const bitDepth = variant.rawBitDepth === 'preserve' ? 'bit維持' : `${variant.rawBitDepth}bit`;
	return `${variant.videoCodec.toUpperCase()} ${formatMbps(variant.videoBitrate)} ${size} ${colorMetadataLabel(variant.colorMetadata)} ${bitDepth} ${chromaSubsamplingLabel(variant.rawChromaSubsampling)}`;
}
const showImage = computed(() => props.forceEnable || props.settings.image.enabled);
const showVideo = computed(() => props.forceEnable || props.settings.video.enabled);
const imageExifLabel = computed(() => {
	if (props.settings.image.exif === 'keep') return 'EXIF維持';
	if (props.settings.image.exif === 'drop') return 'EXIF削除';
	return 'GPS削除';
});
const avifSamplingLabel = computed(() => {
	const chroma = props.settings.image.avifChromaSubsampling;
	const sampling = chroma === '444' ? '4:4:4' : '4:2:0';
	return `${sampling} ${props.settings.image.avifBitDepth}bit`;
});
const imageQualityLabel = computed(() => `${Math.round(props.settings.image.quality * 100)}%`);
const imageColorMetadataLabel = computed(() => colorMetadataLabel(props.settings.image.colorMetadata ?? 'preserve'));
const videoColorMetadataLabel = computed(() => colorMetadataLabel(props.settings.video.colorMetadata ?? 'preserve'));
const videoRawBitDepthLabel = computed(() => {
	const bitDepth = props.settings.video.rawBitDepth ?? 'preserve';
	return bitDepth === 'preserve' ? 'bit維持' : `${bitDepth}bit`;
});
const videoRawChromaSubsamplingLabel = computed(() => chromaSubsamplingLabel(props.settings.video.rawChromaSubsampling ?? 'preserve'));
const hlsSegmentDurationLabel = computed(() => `${props.settings.video.hlsSegmentDuration ?? 2}秒`);
const videoMaxSizeLabel = computed(() => {
	const { maxWidth, maxHeight } = props.settings.video;
	if (maxWidth == null && maxHeight == null) return '自動サイズ';
	return `${maxWidth ?? '自動'} x ${maxHeight ?? '自動'}`;
});

function colorMetadataLabel(policy: MediaColorMetadataPolicy): string {
	if (policy === 'canvas-sdr') return 'Canvas SDR';
	return '色維持';
}

function chromaSubsamplingLabel(chromaSubsampling: MediaVideoRawChromaSubsampling): string {
	if (chromaSubsampling === 'preserve') return 'クロマ維持';
	if (chromaSubsampling === '420') return '4:2:0';
	if (chromaSubsampling === '422') return '4:2:2';
	return '4:4:4';
}
</script>

<template>
  <div :class="$style.root">
    <template v-if="showImage || showVideo">
      <span v-if="showImage" :class="$style.group" role="group" aria-label="画像変換設定" title="画像変換設定">
        <span :class="$style.format">{{ imageOutputLabel }}</span>
        <span v-if="settings.image.outputMime === 'image/avif'" :class="$style.item"><Palette :size="14" :stroke-width="2" aria-hidden="true" />{{ avifSamplingLabel }}</span>
        <span :class="$style.item"><Sparkles :size="14" :stroke-width="2" aria-hidden="true" />{{ imageQualityLabel }}</span>
        <span :class="$style.item"><BadgeInfo :size="14" :stroke-width="2" aria-hidden="true" />{{ imageExifLabel }}</span>
        <span :class="$style.item"><SwatchBook :size="14" :stroke-width="2" aria-hidden="true" />{{ imageColorMetadataLabel }}</span>
        <span :class="$style.item"><Maximize2 :size="14" :stroke-width="2" aria-hidden="true" />{{ settings.image.maxWidth }} x {{ settings.image.maxHeight }}</span>
      </span>
      <span v-if="showImage && showVideo" :class="$style.separator" aria-hidden="true">・</span>
      <span v-if="showVideo" :class="$style.group" role="group" aria-label="動画変換設定" title="動画変換設定">
        <span :class="$style.format">{{ videoOutputLabel }}</span>
        <template v-if="isHlsVideo">
          <span v-for="(variant, index) in hlsVariants" :key="index" :class="$style.item">
            <Clapperboard :size="14" :stroke-width="2" aria-hidden="true" />{{ hlsVariantLabel(variant) }}
          </span>
        </template>
        <span v-else :class="$style.item"><Clapperboard :size="14" :stroke-width="2" aria-hidden="true" />{{ settings.video.videoCodec.toUpperCase() }} {{ formatMbps(settings.video.videoBitrate) }}</span>
        <span :class="$style.item"><AudioLines :size="14" :stroke-width="2" aria-hidden="true" />{{ settings.video.audioCodec.toUpperCase() }} {{ formatKbps(settings.video.audioBitrate) }}</span>
        <span v-if="isHlsVideo" :class="$style.item"><Timer :size="14" :stroke-width="2" aria-hidden="true" />{{ hlsSegmentDurationLabel }}</span>
        <span v-if="!isHlsVideo" :class="$style.item"><SwatchBook :size="14" :stroke-width="2" aria-hidden="true" />{{ videoColorMetadataLabel }}</span>
        <span v-if="!isHlsVideo" :class="$style.item"><Palette :size="14" :stroke-width="2" aria-hidden="true" />{{ videoRawBitDepthLabel }}</span>
        <span v-if="!isHlsVideo" :class="$style.item"><ScanLine :size="14" :stroke-width="2" aria-hidden="true" />{{ videoRawChromaSubsamplingLabel }}</span>
        <span v-if="!isHlsVideo" :class="$style.item"><Maximize2 :size="14" :stroke-width="2" aria-hidden="true" />{{ videoMaxSizeLabel }}</span>
      </span>
    </template>
    <span v-else :class="$style.item"><X :size="14" :stroke-width="2" aria-hidden="true" />変換なし</span>
  </div>
</template>

<style module lang="scss">
.root {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.group,
.item,
.format {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.group {
  gap: 8px;
  flex-wrap: wrap;
}

.format {
  color: var(--color-text);
  font-weight: 600;
}

.separator {
  color: var(--color-text-muted);
}

.item {
  gap: 4px;
}

.item svg {
  flex: 0 0 auto;
  color: var(--color-text-muted);
}
</style>
