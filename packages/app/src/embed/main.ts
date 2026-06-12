/**
 * /e/:fileId 埋め込みプレイヤーのエントリポイント。
 * Vue/SPA に依存しない軽量構成。設定は Worker が #embed-config に注入する。
 */

interface EmbedConfig {
	fileId: string;
	masterUrl: string;
	posterUrl: string | null;
	title: string | null;
}

function readConfig(): EmbedConfig | null {
	const element = document.getElementById('embed-config');
	if (!element?.textContent) return null;
	try {
		const parsed = JSON.parse(element.textContent) as Partial<EmbedConfig>;
		if (typeof parsed.fileId !== 'string' || typeof parsed.masterUrl !== 'string') return null;
		return {
			fileId: parsed.fileId,
			masterUrl: parsed.masterUrl,
			posterUrl: typeof parsed.posterUrl === 'string' ? parsed.posterUrl : null,
			title: typeof parsed.title === 'string' ? parsed.title : null,
		};
	} catch {
		return null;
	}
}

function showError(message: string): void {
	const video = document.getElementById('video');
	video?.remove();
	const paragraph = document.createElement('p');
	paragraph.className = 'embed-error';
	paragraph.textContent = message;
	document.body.append(paragraph);
}

async function main(): Promise<void> {
	const config = readConfig();
	const video = document.getElementById('video') as HTMLVideoElement | null;
	if (!config || !video) {
		showError('動画の情報を読み込めませんでした。');
		return;
	}
	if (config.title) document.title = config.title;
	if (config.posterUrl) video.poster = config.posterUrl;

	// ネイティブHLS対応 (iOS/macOS Safari) を優先し、それ以外は hls.js を使う
	if (video.canPlayType('application/vnd.apple.mpegurl')) {
		video.src = config.masterUrl;
		return;
	}
	try {
		const { default: Hls } = await import('hls.js');
		if (!Hls.isSupported()) {
			showError('このブラウザは HLS の再生に対応していません。');
			return;
		}
		const hls = new Hls();
		hls.on(Hls.Events.ERROR, (_event, data) => {
			if (!data.fatal) return;
			hls.destroy();
			showError(`HLS の再生に失敗しました (${data.details})`);
		});
		hls.loadSource(config.masterUrl);
		hls.attachMedia(video);
	} catch {
		showError('プレイヤーの読み込みに失敗しました。');
	}
}

void main();
