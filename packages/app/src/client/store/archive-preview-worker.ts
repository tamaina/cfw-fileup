import { watch } from 'vue';
import { authStore } from '@/store/auth';
import type { ArchivePreviewWorkerRequest, ArchivePreviewWorkerResponse } from '@/workers/archive-preview-worker-types';

type PendingRequest = { resolve: (blob: Blob) => void; reject: (error: Error) => void };

let worker: Worker | null = null;
let requestSequence = 0;
const pending = new Map<string, PendingRequest>();

function getWorker(): Worker {
	if (worker) return worker;
	worker = new Worker(new URL('../workers/archive-preview.worker.ts', import.meta.url), { type: 'module' });
	worker.onmessage = (event: MessageEvent<ArchivePreviewWorkerResponse>) => {
		const message = event.data;
		const request = pending.get(message.requestId);
		if (!request) return;
		pending.delete(message.requestId);
		if (message.type === 'result') request.resolve(message.blob);
		else request.reject(new Error(message.type === 'cancelled' ? 'Preview request cancelled' : message.error));
	};
	worker.onerror = () => {
		for (const request of pending.values()) request.reject(new Error('Archive preview worker failed'));
		pending.clear();
		worker?.terminate();
		worker = null;
	};
	return worker;
}

function post(message: ArchivePreviewWorkerRequest): void {
	getWorker().postMessage(message);
}

export function requestArchivePreview(input: Omit<Extract<ArchivePreviewWorkerRequest, { type: 'preview' }>, 'type' | 'requestId'>): Promise<Blob> {
	const requestId = String(++requestSequence);
	const promise = new Promise<Blob>((resolve, reject) => pending.set(requestId, { resolve, reject }));
	post({ type: 'preview', requestId, ...input });
	return promise;
}

export function cancelArchivePreviewConsumer(consumerId: string): void {
	if (!worker) return;
	worker.postMessage({ type: 'cancel-consumer', consumerId } satisfies ArchivePreviewWorkerRequest);
}

export function clearArchivePreviewContext(archiveId: string, encryptionKey: string): void {
	if (!worker) return;
	worker.postMessage({ type: 'clear-context', archiveId, encryptionKey } satisfies ArchivePreviewWorkerRequest);
}

export function evictArchivePreview(archiveId: string, entryId: string, encryptionKey: string): void {
	if (!worker) return;
	worker.postMessage({ type: 'evict', archiveId, entryId, encryptionKey } satisfies ArchivePreviewWorkerRequest);
}

export function clearArchivePreviewCache(): void {
	if (!worker) return;
	worker.postMessage({ type: 'clear-all' } satisfies ArchivePreviewWorkerRequest);
}

watch(() => authStore.token, (token, previousToken) => {
	if (previousToken && !token) clearArchivePreviewCache();
});
