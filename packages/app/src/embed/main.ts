/**
 * /e/:fileId 埋め込みプレイヤーのエントリポイント。
 * Vue/SPA に依存しない軽量構成。fileId から HLS tar の中身を解決する。
 */

import { archiveEntryStreamUrl } from '../shared/archive-entry-url';
import { hlsPosterEntryPath, parseHlsSessionData } from '../shared/hls';

interface EmbedConfig {
	fileId: string;
	masterUrl: string;
	posterUrl: string | null;
	title: string | null;
}

function readFileId(): string | null {
	const match = /^\/e\/([^/?#]+)/.exec(location.pathname);
	return match ? decodeURIComponent(match[1]) : null;
}

function readAutoplay(): boolean {
	const params = new URLSearchParams(location.search);
	const values = [...params.getAll('autoplay'), ...params.getAll('auto_play')];
	if (values.length === 0) return false;
	return values.some(value => !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase()));
}

function showError(message: string): void {
	const video = document.getElementById('video');
	video?.remove();
	const paragraph = document.createElement('p');
	paragraph.className = 'embed-error';
	paragraph.textContent = message;
	document.body.append(paragraph);
}

function configureAutoplay(video: HTMLVideoElement, autoplay: boolean): void {
	if (!autoplay) return;
	video.autoplay = true;
	video.muted = true;
	video.defaultMuted = true;
	video.playsInline = true;
}

async function playAutoplay(video: HTMLVideoElement, autoplay: boolean): Promise<void> {
	if (!autoplay) return;
	try {
		await video.play();
	} catch {
		// ブラウザの自動再生ポリシーで拒否された場合は、controls から手動再生できる状態にする。
	}
}

async function loadConfig(): Promise<EmbedConfig | null> {
	const fileId = readFileId();
	if (!fileId) return null;

	const listRes = await fetch(`/d/${encodeURIComponent(fileId)}?list`);
	if (!listRes.ok) return null;
	const entries = await listRes.json() as Array<{ path: string; mimeType: string }>;
	const master = entries.find(entry => entry.path.split('/').pop() === 'master.m3u8')
		?? entries.find(entry => entry.path.toLowerCase().endsWith('.m3u8'));
	if (!master) return null;

	const masterUrl = archiveEntryStreamUrl(fileId, master.path);
	let title: string | null = null;
	let posterUrl: string | null = null;
	try {
		const masterRes = await fetch(masterUrl);
		if (masterRes.ok) {
			const meta = parseHlsSessionData(await masterRes.text());
			title = meta.title;
		}
	} catch {
		// メタ情報が読めなくても、プレイリスト URL があれば再生は試せる。
	}

	const posterPath = hlsPosterEntryPath(master.path);
	if (entries.some(entry => entry.path === posterPath)) {
		posterUrl = archiveEntryStreamUrl(fileId, posterPath);
	}

	return { fileId, masterUrl, posterUrl, title };
}

async function main(): Promise<void> {
	const video = document.getElementById('video') as HTMLVideoElement | null;
	const config = await loadConfig();
	if (!config || !video) {
		showError('動画の情報を読み込めませんでした。');
		return;
	}
	if (config.title) document.title = config.title;
	if (config.posterUrl) video.poster = config.posterUrl;
	const autoplay = readAutoplay();
	configureAutoplay(video, autoplay);

	// Safari でも ManagedMediaSource 経由で hls.js を使える環境では hls.js を優先する。
	// hls.js が非対応判定した環境だけ native HLS に fallback する。
	try {
		const { default: Hls } = await import('hls.js');
		if (Hls.isSupported()) {
			const hls = new Hls({
				preferManagedMediaSource: true,
			});
			hls.on(Hls.Events.ERROR, (_event, data) => {
				if (!data.fatal) return;
				hls.destroy();
				showError(`HLS の再生に失敗しました (${data.details})`);
			});
			hls.on(Hls.Events.MANIFEST_PARSED, () => {
				void playAutoplay(video, autoplay);
			});
			hls.loadSource(config.masterUrl);
			hls.attachMedia(video);
			return;
		}
		if (video.canPlayType('application/vnd.apple.mpegurl')) {
			video.src = config.masterUrl;
			await playAutoplay(video, autoplay);
			return;
		}
		showError('このブラウザは HLS の再生に対応していません。');
	} catch {
		if (video.canPlayType('application/vnd.apple.mpegurl')) {
			video.src = config.masterUrl;
			await playAutoplay(video, autoplay);
			return;
		}
		showError('プレイヤーの読み込みに失敗しました。');
	}
}

void main();
