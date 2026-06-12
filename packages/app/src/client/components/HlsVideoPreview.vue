<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { authStore } from '@/store/auth';
import { HlsVideoPlayback } from '../../shared/hls-video-playback';

const props = defineProps<{
	/** プレイリスト(.m3u8)のURL。相対パス解決のためスラッシュは温存されていること */
	src: string;
	token?: string | null;
	poster?: string | null;
}>();

const videoElement = ref<HTMLVideoElement | null>(null);
const error = ref('');
const loading = ref(true);
let playback: HlsVideoPlayback | null = null;
let setupSequence = 0;
let playbackKey: string | null = null;
let setupKeyInProgress: string | null = null;

function currentPlaybackKey(): string {
	return JSON.stringify([props.src, props.token ?? null]);
}

function withToken(url: string): string {
	if (!props.token) return url;
	const parsed = new URL(url, location.origin);
	if (!parsed.searchParams.has('token')) parsed.searchParams.set('token', props.token);
	if (parsed.protocol === location.protocol && parsed.host === location.host) {
		return `${parsed.pathname}${parsed.search}`;
	}
	return parsed.toString();
}

function teardown(): void {
	playback?.destroy();
	playback = null;
	playbackKey = null;
}

function showPlaybackError(message: string, cause: unknown): void {
	console.error(message, cause);
	loading.value = false;
	error.value = message;
}

async function setup(): Promise<void> {
	const key = currentPlaybackKey();
	if (key === playbackKey || key === setupKeyInProgress) {
		console.error('HLS video preview setup skipped', {
			key,
			playbackKey,
			setupKeyInProgress,
			src: props.src,
		});
		return;
	}
	const sequence = ++setupSequence;
	setupKeyInProgress = key;
	console.error('HLS video preview setup started', {
		sequence,
		key,
		src: props.src,
		hasToken: props.token != null,
	});
	teardown();
	error.value = '';
	loading.value = true;
	const video = videoElement.value;
	if (!video || !props.src) {
		setupKeyInProgress = null;
		return;
	}
	try {
		const nextPlayback = new HlsVideoPlayback({
			video,
			src: props.src,
			transformUrl: withToken,
			getRequestHeaders: () => authStore.token ? { Authorization: `Bearer ${authStore.token}` } : undefined,
			onReady: () => {
				loading.value = false;
			},
			onError: showPlaybackError,
			onUnsupported: () => {
				loading.value = false;
				error.value = 'このブラウザは HLS の再生に対応していません。';
			},
		});
		await nextPlayback.load();
		if (sequence !== setupSequence) {
			nextPlayback.destroy();
			return;
		}
		playback = nextPlayback;
		playbackKey = key;
		console.error('HLS video preview setup completed', {
			sequence,
			key,
			src: props.src,
		});
	} catch (err) {
		if (sequence !== setupSequence) return;
		loading.value = false;
		console.error('HLS video preview setup failed', err, { src: props.src });
		error.value = err instanceof Error ? err.message : String(err);
	} finally {
		if (setupKeyInProgress === key) setupKeyInProgress = null;
	}
}

watch([() => props.src, () => props.token], () => {
	void setup();
});

onMounted(() => {
	void setup();
});

onBeforeUnmount(() => {
	setupSequence++;
	teardown();
});
</script>

<template>
  <div :class="$style.root">
    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <video
      ref="videoElement"
      :class="$style.video"
      :poster="poster ?? undefined"
      controls
      playsinline
      preload="metadata"
    />
    <div v-if="loading && !error" class="page-loading">
      <span class="spinner" />読み込み中...
    </div>
  </div>
</template>

<style module lang="scss">
.root {
  display: grid;
  gap: 8px;
}

.video {
  width: 100%;
  max-height: 70vh;
  border-radius: var(--radius-lg);
  background: #000;
}
</style>
