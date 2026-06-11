import { readonly, ref } from 'vue';
import type {
	MediaConversionProgress,
	MediaConversionWorkerMessage,
	MediaConversionWorkerRequest,
} from '@/workers/media-conversion.worker';
import type { UploadResolvedEntry } from '@/workers/upload-worker-types';

export type MediaConversionJobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface MediaConversionJobSnapshot {
	id: string;
	status: MediaConversionJobStatus;
	title: string;
	filename: string;
	fileIndex: number;
	totalFiles: number;
	phase: MediaConversionProgress['phase'];
	progress: number | null;
	createdAt: number;
	updatedAt: number;
	uploadJobId?: string;
	error?: string;
	fallbackError?: string;
}

export interface MediaConversionWorkerHandlers {
	onProgress?: (progress: MediaConversionProgress) => void;
	onConvertedEntry?: (entry: UploadResolvedEntry) => void | Promise<void>;
	onFallbackEntry?: (entry: UploadResolvedEntry, error: string) => void | Promise<void>;
}

export interface MediaConversionWorkerOptions extends MediaConversionWorkerHandlers {
	title?: string;
	uploadJobId?: string;
}

const jobs = ref<MediaConversionJobSnapshot[]>([]);
let worker: Worker | null = null;
let activeReject: ((reason?: unknown) => void) | null = null;
let activeRequestId: string | null = null;

export const mediaConversionJobs = readonly(jobs);

export function terminateMediaConversionWorker(): void {
	worker?.terminate();
	worker = null;
	if (activeRequestId) updateJob(activeRequestId, { status: 'cancelled', error: 'Media conversion was cancelled' });
	activeRequestId = null;
	activeReject?.(new Error('Media conversion was cancelled'));
	activeReject = null;
}

export function runMediaConversionWorker(request: MediaConversionWorkerRequest, options: MediaConversionWorkerOptions = {}): Promise<void> {
	terminateMediaConversionWorker();
	worker = new Worker(new URL('../workers/media-conversion.worker.ts', import.meta.url), { type: 'module' });
	activeRequestId = request.id;
	upsertJob({
		id: request.id,
		status: 'running',
		title: options.title ?? 'メディア変換',
		filename: request.files[0]?.path ?? '',
		fileIndex: 0,
		totalFiles: request.files.length,
		phase: 'converting',
		progress: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		uploadJobId: options.uploadJobId,
	});

	return new Promise<void>((resolve, reject) => {
		const pendingHandlers: Promise<void>[] = [];
		const currentWorker = worker;
		activeReject = reject;
		if (!currentWorker) {
			reject(new Error('Media conversion worker is not available'));
			return;
		}

		currentWorker.onmessage = (event: MessageEvent<MediaConversionWorkerMessage>) => {
			const message = event.data;
			if (message.id !== request.id) return;
			if (message.type === 'progress') {
				updateJob(request.id, {
					status: 'running',
					filename: message.progress.fileName,
					fileIndex: message.progress.fileIndex,
					totalFiles: message.progress.totalFiles,
					phase: message.progress.phase,
					progress: message.progress.videoProgress ?? null,
				});
				options.onProgress?.(message.progress);
				return;
			}
			if (message.type === 'converted-entry') {
				pendingHandlers.push(Promise.resolve(options.onConvertedEntry?.(message.entry)));
				return;
			}
			if (message.type === 'fallback-entry') {
				updateJob(request.id, { fallbackError: message.error });
				pendingHandlers.push(Promise.resolve(options.onFallbackEntry?.(message.entry, message.error)));
				return;
			}
			currentWorker.terminate();
			if (worker === currentWorker) worker = null;
			activeReject = null;
			activeRequestId = null;
			if (message.type === 'done') {
				Promise.all(pendingHandlers).then(() => {
					updateJob(request.id, { status: 'done', progress: 1 });
					resolve();
				}, reject);
				return;
			}
			updateJob(request.id, { status: 'error', error: message.error });
			reject(new Error(message.error));
		};
		currentWorker.onerror = (event) => {
			if (worker === currentWorker) worker = null;
			activeReject = null;
			activeRequestId = null;
			currentWorker.terminate();
			updateJob(request.id, { status: 'error', error: event.message });
			reject(new Error(event.message));
		};
		currentWorker.postMessage(request);
	});
}

function upsertJob(job: MediaConversionJobSnapshot): void {
	jobs.value = [job, ...jobs.value.filter(current => current.id !== job.id)].slice(0, 50);
}

function updateJob(id: string, patch: Partial<Omit<MediaConversionJobSnapshot, 'id' | 'createdAt'>>): void {
	jobs.value = jobs.value.map(job => job.id === id ? { ...job, ...patch, updatedAt: Date.now() } : job);
}
