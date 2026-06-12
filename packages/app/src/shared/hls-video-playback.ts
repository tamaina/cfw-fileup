import type Hls from 'hls.js';
import type { ErrorData, HlsConfig } from 'hls.js';

export interface HlsVideoPlaybackOptions {
	video: HTMLVideoElement;
	src: string;
	autoplay?: boolean;
	transformUrl?: (url: string) => string;
	getRequestHeaders?: () => HeadersInit | undefined;
	onReady?: () => void;
	onError?: (message: string, cause: unknown) => void;
	onUnsupported?: () => void;
}

function canPlayNativeHls(video: HTMLVideoElement): boolean {
	return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

async function playAutoplay(video: HTMLVideoElement, autoplay: boolean): Promise<void> {
	if (!autoplay) return;
	try {
		await video.play();
	} catch {
		// ブラウザの自動再生ポリシーで拒否された場合は、controls から手動再生できる状態にする。
	}
}

function clearVideoSource(video: HTMLVideoElement): void {
	video.removeAttribute('src');
	video.load();
}

export class HlsVideoPlayback {
	readonly #video: HTMLVideoElement;
	readonly #src: string;
	readonly #autoplay: boolean;
	readonly #transformUrl: (url: string) => string;
	readonly #getRequestHeaders?: () => HeadersInit | undefined;
	readonly #onReady?: () => void;
	readonly #onError?: (message: string, cause: unknown) => void;
	readonly #onUnsupported?: () => void;
	#hls: Hls | null = null;
	#nativeErrorController: AbortController | null = null;
	#destroyed = false;
	#recoveredMediaError = false;
	#handlingFatalError = false;
	#nativeFallbackTried = false;
	#errorReported = false;

	constructor(options: HlsVideoPlaybackOptions) {
		this.#video = options.video;
		this.#src = options.src;
		this.#autoplay = options.autoplay ?? false;
		this.#transformUrl = options.transformUrl ?? (url => url);
		this.#getRequestHeaders = options.getRequestHeaders;
		this.#onReady = options.onReady;
		this.#onError = options.onError;
		this.#onUnsupported = options.onUnsupported;
	}

	async load(): Promise<void> {
		try {
			const { default: HlsClass } = await import('hls.js');
			if (this.#destroyed) return;
			if (HlsClass.isSupported()) {
				this.#loadWithHls(HlsClass);
				return;
			}
			if (await this.#loadNativeHls()) return;
			this.#onUnsupported?.();
		} catch (err) {
			console.warn('hls.js player setup failed', err);
			if (this.#destroyed) return;
			if (await this.#loadNativeHls()) return;
			this.#onError?.('プレイヤーの読み込みに失敗しました。', err);
		}
	}

	destroy(): void {
		this.#destroyed = true;
		this.#hls?.destroy();
		this.#hls = null;
		this.#nativeErrorController?.abort();
		this.#nativeErrorController = null;
		clearVideoSource(this.#video);
	}

	#loadWithHls(HlsClass: typeof Hls): void {
		const hlsConfig: Partial<HlsConfig> = {
			// ManagedMediaSource 経由の hls.js 再生は Safari で不安定な場合がある。
			// hls.js が非対応判定した環境だけ native HLS に fallback する。
			preferManagedMediaSource: false,
			xhrSetup: (xhr, url) => {
				xhr.open('GET', this.#transformUrl(url), true);
				const headers = new Headers(this.#getRequestHeaders?.());
				for (const [name, value] of headers) {
					xhr.setRequestHeader(name, value);
				}
			},
			fetchSetup: (context, initParams) => {
				const headers = new Headers(initParams.headers);
				for (const [name, value] of new Headers(this.#getRequestHeaders?.())) {
					headers.set(name, value);
				}
				return new Request(this.#transformUrl(context.url), {
					...initParams,
					headers,
				});
			},
		};
		this.#hls = new HlsClass(hlsConfig);
		this.#hls.on(HlsClass.Events.MEDIA_ATTACHED, () => {
			if (!this.#destroyed) this.#hls?.loadSource(this.#transformUrl(this.#src));
		});
		this.#hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
			this.#onReady?.();
			void playAutoplay(this.#video, this.#autoplay);
		});
		this.#hls.on(HlsClass.Events.ERROR, (_event, data) => {
			this.#handleHlsError(HlsClass, data);
		});
		this.#hls.attachMedia(this.#video);
	}

	async #loadNativeHls(): Promise<boolean> {
		if (this.#nativeFallbackTried) return false;
		this.#nativeFallbackTried = true;
		if (!canPlayNativeHls(this.#video)) return false;
		this.#nativeErrorController?.abort();
		this.#nativeErrorController = new AbortController();
		this.#video.addEventListener('error', () => {
			if (this.#destroyed) return;
			this.#onError?.('HLS の再生に失敗しました (nativeHlsError)', this.#video.error);
		}, {
			once: true,
			signal: this.#nativeErrorController.signal,
		});
		this.#video.src = this.#transformUrl(this.#src);
		this.#video.load();
		this.#onReady?.();
		await playAutoplay(this.#video, this.#autoplay);
		return true;
	}

	#handleHlsError(HlsClass: typeof Hls, data: ErrorData): void {
		if (!data.fatal || this.#destroyed) return;
		console.warn('hls.js fatal playback error', data);
		if (data.details === HlsClass.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET) {
			this.#recoveredMediaError = true;
			return;
		}
		if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && !this.#recoveredMediaError) {
			this.#recoveredMediaError = true;
			this.#hls?.recoverMediaError();
			return;
		}
		if (this.#handlingFatalError) return;
		this.#handlingFatalError = true;
		this.#hls?.destroy();
		this.#hls = null;
		this.#reportPlaybackError(data);
	}

	#reportPlaybackError(data: ErrorData, nativeFallbackError?: unknown): void {
		if (this.#errorReported) return;
		this.#errorReported = true;
		this.#onError?.(`HLS の再生に失敗しました (${data.details})`, nativeFallbackError === undefined ? data : {
			hlsError: data,
			nativeFallbackError,
		});
	}
}
