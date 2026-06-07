import { computed, readonly, ref } from 'vue';

export type DownloadStatusPhase = 'resolving' | 'reading' | 'writing' | 'done' | 'error';

export interface DownloadStatusProgress {
	readonly phase: DownloadStatusPhase;
	readonly processedFiles: number;
	readonly totalFiles: number;
	readonly currentFile: string;
	readonly completedBytes?: number;
	readonly totalBytes?: number;
}

export interface DownloadStatus {
	readonly id: string;
	readonly filename: string;
	readonly progress: DownloadStatusProgress;
	readonly error?: string;
	readonly startedAt: number;
	readonly updatedAt: number;
}

const currentDownloadStatus = ref<DownloadStatus | null>(null);
const downloadStatuses = ref<DownloadStatus[]>([]);

export const downloadStatus = readonly(currentDownloadStatus);
export const downloadStatusHistory = readonly(downloadStatuses);
export const downloadStatusPercent = computed(() => {
	const progress = currentDownloadStatus.value?.progress;
	if (!progress) return 0;
	return getDownloadProgressPercent(progress);
});

export function startDownloadStatus(id: string, filename: string): void {
	const now = Date.now();
	const status: DownloadStatus = {
		id,
		filename,
		progress: { phase: 'resolving', processedFiles: 0, totalFiles: 0, currentFile: filename },
		startedAt: now,
		updatedAt: now,
	};
	currentDownloadStatus.value = status;
	downloadStatuses.value = [status, ...downloadStatuses.value.filter(item => item.id !== id)];
}

export function updateDownloadStatus(id: string, progress: DownloadStatusProgress): void {
	const current = currentDownloadStatus.value;
	if (!current || current.id !== id) return;
	setDownloadStatus({ ...current, progress, updatedAt: Date.now() });
}

export function completeDownloadStatus(id: string): void {
	const current = currentDownloadStatus.value;
	if (!current || current.id !== id) return;
	const totalBytes = current.progress.totalBytes ?? 0;
	setDownloadStatus({
		...current,
		progress: {
			...current.progress,
			phase: 'done',
			processedFiles: current.progress.totalFiles || current.progress.processedFiles,
			...(totalBytes > 0 ? { completedBytes: totalBytes } : {}),
		},
		updatedAt: Date.now(),
	});
}

export function failDownloadStatus(id: string, error: string): void {
	const current = currentDownloadStatus.value;
	if (!current || current.id !== id) return;
	setDownloadStatus({
		...current,
		error,
		progress: { ...current.progress, phase: 'error' },
		updatedAt: Date.now(),
	});
}

export function getDownloadStatusPercent(status: DownloadStatus): number {
	return getDownloadProgressPercent(status.progress);
}

function setDownloadStatus(status: DownloadStatus): void {
	currentDownloadStatus.value = status;
	downloadStatuses.value = downloadStatuses.value.map(item => item.id === status.id ? status : item);
}

function getDownloadProgressPercent(progress: DownloadStatusProgress): number {
	if (progress.phase === 'done') return 100;
	const totalBytes = progress.totalBytes ?? 0;
	if (totalBytes > 0) {
		return Math.min(100, Math.round((progress.completedBytes ?? 0) / totalBytes * 100));
	}
	if (progress.totalFiles <= 0) return 0;
	return Math.min(100, Math.round(progress.processedFiles / progress.totalFiles * 100));
}
