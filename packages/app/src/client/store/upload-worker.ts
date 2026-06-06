import { computed, readonly, ref } from 'vue';
import type {
	UploadJobRequest,
	UploadJobSnapshot,
	UploadWorkerClientMessage,
	UploadWorkerServerMessage,
} from '@/workers/upload-worker-types';

const jobs = ref<UploadJobSnapshot[]>([]);
let port: MessagePort | null = null;
let fallbackNoticeShown = false;
const enqueueResolvers: Array<(jobId: string) => void> = [];

export const uploadWorkerJobs = readonly(jobs);
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
		if (message.type === 'snapshot') jobs.value = message.jobs;
		if (message.type === 'enqueued') enqueueResolvers.shift()?.(message.jobId);
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

function post(message: UploadWorkerClientMessage): void {
	port?.postMessage(message);
}
