<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import type Hls from 'hls.js';
import { authStore } from '@/store/auth';

const props = defineProps<{
	/** プレイリスト(.m3u8)のURL。相対パス解決のためスラッシュは温存されていること */
	src: string;
	token?: string | null;
	poster?: string | null;
}>();

const videoElement = ref<HTMLVideoElement | null>(null);
const error = ref('');
const loading = ref(true);
let hls: Hls | null = null;
let setupSequence = 0;

function withToken(url: string): string {
	if (!props.token) return url;
	const parsed = new URL(url, location.origin);
	if (!parsed.searchParams.has('token')) parsed.searchParams.set('token', props.token);
	return parsed.origin === location.origin ? `${parsed.pathname}${parsed.search}` : parsed.toString();
}

function teardown(): void {
	hls?.destroy();
	hls = null;
	const video = videoElement.value;
	if (video) {
		video.removeAttribute('src');
		video.load();
	}
}

async function setup(): Promise<void> {
	const sequence = ++setupSequence;
	teardown();
	error.value = '';
	loading.value = true;
	const video = videoElement.value;
	if (!video || !props.src) return;
	try {
		const { default: HlsClass } = await import('hls.js');
		if (sequence !== setupSequence) return;
		if (HlsClass.isSupported()) {
			hls = new HlsClass({
				// ManagedMediaSource 経由の hls.js 再生は Safari で不安定な場合がある。
				// hls.js が非対応判定した環境だけ native HLS に fallback する。
				preferManagedMediaSource: false,
				xhrSetup: (xhr, url) => {
					// 相対解決されたセグメントURLには token が付かないため、ここで付与する
					xhr.open('GET', withToken(url), true);
					if (authStore.token) {
						xhr.setRequestHeader('Authorization', `Bearer ${authStore.token}`);
					}
				},
				fetchSetup: (context, initParams) => {
					const headers = new Headers(initParams.headers);
					if (authStore.token) {
						headers.set('Authorization', `Bearer ${authStore.token}`);
					}
					return new Request(withToken(context.url), {
						...initParams,
						headers,
					});
				},
			});
			hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
				loading.value = false;
			});
			hls.on(HlsClass.Events.ERROR, (_event, data) => {
				if (!data.fatal) return;
				loading.value = false;
				error.value = `HLS の再生に失敗しました (${data.details})`;
				teardown();
			});
			hls.loadSource(withToken(props.src));
			hls.attachMedia(video);
			return;
		}
		if (video.canPlayType('application/vnd.apple.mpegurl')) {
			// ネイティブHLS (MSE非対応のSafariなど)。セグメントに token は付与できないため、
			// 非公開ファイルでは再生できないことがある。
			video.src = withToken(props.src);
			loading.value = false;
			return;
		}
		loading.value = false;
		error.value = 'このブラウザは HLS の再生に対応していません。';
	} catch (err) {
		if (sequence !== setupSequence) return;
		loading.value = false;
		console.error('HLS video preview setup failed', err, { src: props.src });
		error.value = err instanceof Error ? err.message : String(err);
	}
}

watch(() => [props.src, props.token], () => {
	void setup();
});

watch(videoElement, (element) => {
	if (element) void setup();
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
