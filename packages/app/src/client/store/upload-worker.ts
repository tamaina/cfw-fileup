import { computed, readonly, ref } from 'vue';
import type {
	UploadJobRequest,
	UploadJobSnapshot,
	UploadResolvedEntry,
	UploadStreamingJobRequest,
	UploadWorkerClientMessage,
	UploadWorkerServerMessage,
} from '@/workers/upload-worker-types';
import { saveEncryptionKey } from '@/utils/encryption-key-store';

const jobs = ref<UploadJobSnapshot[]>([]);
const encryptionKeys = ref<Record<string, string>>({});
let port: MessagePort | null = null;
let fallbackNoticeShown = false;
const enqueueResolvers: Array<(jobId: string) => void> = [];
const streamingResolvers = new Map<string, (jobId: string) => void>();

export const uploadWorkerJobs = readonly(jobs);
export const uploadEncryptionKeys = readonly(encryptionKeys);
export const activeUploadJobs = computed(() => jobs.value.filter(job => job.status === 'queued' || job.status === 'running'));
export const latestActiveUploadJob = computed(() => activeUploadJobs.value[0] ?? null);
export const latestUploadJob = computed(() => jobs.value[0] ?? null);

export function connectUploadWorker(): void {
	if (port || typeof window === 'undefined') return;
	if (!('SharedWorker' in window)) {
		if (!fallbackNoticeShown) {
			console.warn('SharedWorker is not supported in this browser; cross-tab upload progress is unavailable.');
			fallbackNoticeShown = true;
		}
		return;
	}
	const worker = new SharedWorker(new URL('../workers/upload-worker.ts', import.meta.url), { type: 'module' });
	port = worker.port;
	port.onmessage = (event: MessageEvent<UploadWorkerServerMessage>) => {
		const message = event.data;
		if (message.type === 'snapshot') {
			const previousJobs = jobs.value;
			jobs.value = message.jobs;
			// Persist encryption keys to IndexedDB when jobs complete
			for (const job of message.jobs) {
				if (job.status !== 'done' || !job.fileIds?.length) continue;
				const key = encryptionKeys.value[job.id];
				if (!key) continue;
				const previous = previousJobs.find(j => j.id === job.id);
				if (previous?.status === 'done') continue; // already processed
				for (const fileId of job.fileIds) {
					saveEncryptionKey(fileId, key).catch(() => {});
				}
			}
		}
		if (message.type === 'encryption-key') {
			encryptionKeys.value = { ...encryptionKeys.value, [message.jobId]: message.key };
		}
		if (message.type === 'enqueued') {
			if (message.requestId) {
				streamingResolvers.get(message.requestId)?.(message.jobId);
				streamingResolvers.delete(message.requestId);
			} else {
				enqueueResolvers.shift()?.(message.jobId);
			}
		}
	};
	port.start();
	post({ type: 'subscribe' });
}

export function enqueueUploadJob(job: UploadJobRequest): Promise<string> {
	connectUploadWorker();
	if (!port) throw new Error('SharedWorker is not available');
	return new Promise(resolve => {
		enqueueResolvers.push(resolve);
		post({ type: 'enqueue', job });
	});
}

export function enqueueStreamingUploadJob(job: UploadStreamingJobRequest): Promise<string> {
	connectUploadWorker();
	if (!port) throw new Error('SharedWorker is not available');
	const requestId = crypto.randomUUID();
	return new Promise(resolve => {
		streamingResolvers.set(requestId, resolve);
		post({ type: 'enqueue-streaming', requestId, job });
	});
}

export function pushUploadEntry(jobId: string, entry: UploadResolvedEntry): void {
	post({ type: 'push-entry', jobId, entry });
}

export function finishUploadEntries(jobId: string): void {
	post({ type: 'finish-entries', jobId });
}

export function failUploadEntries(jobId: string, error: string): void {
	post({ type: 'fail-entries', jobId, error });
}

export function getUploadEncryptionKey(jobId: string): string | undefined {
	return encryptionKeys.value[jobId];
}

function post(message: UploadWorkerClientMessage): void {
	port?.postMessage(message);
}
