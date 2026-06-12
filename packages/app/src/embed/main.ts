/**
 * /e/:fileId 埋め込みプレイヤーのエントリポイント。
 * Vue/SPA に依存しない軽量構成。fileId から HLS tar の中身を解決する。
 */

import { archiveEntryStreamUrl } from '../shared/archive-entry-url';
import { hlsPosterEntryPath, parseHlsSessionData } from '../shared/hls';
import { HlsVideoPlayback } from '../shared/hls-video-playback';

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
	document.querySelector('.embed-error')?.remove();
	const paragraph = document.createElement('p');
	paragraph.className = 'embed-error';
	paragraph.textContent = message;
	document.body.append(paragraph);
}

function showPlaybackError(message: string, cause: unknown): void {
	console.error(message, cause);
	showError(message);
}

function configureAutoplay(video: HTMLVideoElement, autoplay: boolean): void {
	if (!autoplay) return;
	video.autoplay = true;
	video.muted = true;
	video.defaultMuted = true;
	video.playsInline = true;
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

	const playback = new HlsVideoPlayback({
		video,
		src: config.masterUrl,
		autoplay,
		onError: showPlaybackError,
		onUnsupported: () => {
			showError('このブラウザは HLS の再生に対応していません。');
		},
	});
	await playback.load();
}

void main();
