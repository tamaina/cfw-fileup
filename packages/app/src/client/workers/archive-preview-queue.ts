import type { ArchivePreviewRequest, ArchivePreviewWorkerResponse } from './archive-preview-worker-types';

export const ARCHIVE_PREVIEW_CONCURRENCY = 3;
export const ARCHIVE_PREVIEW_CACHE_SIZE = 30;
export const ARCHIVE_PREVIEW_CACHE_BYTES = 24 * 1024 * 1024;

type Subscriber = Pick<ArchivePreviewRequest, 'requestId' | 'consumerId' | 'entryId'>;
type Job = {
	key: string;
	request: ArchivePreviewRequest;
	subscribers: Map<string, Subscriber>;
	controller?: AbortController;
};

export interface ArchivePreviewQueueOptions {
	load: (request: ArchivePreviewRequest, signal: AbortSignal) => Promise<Blob>;
	respond: (message: ArchivePreviewWorkerResponse) => void;
	concurrency?: number;
	cacheSize?: number;
	cacheBytes?: number;
}

function previewKey(request: Pick<ArchivePreviewRequest, 'archiveId' | 'entryId' | 'encryptionKey'>): string {
	return JSON.stringify([request.archiveId, request.entryId, request.encryptionKey]);
}

/** 同一プレビューを集約し、並列数と復号済みBlobのLRUを管理する。 */
export class ArchivePreviewQueue {
	readonly #load: ArchivePreviewQueueOptions['load'];
	readonly #respond: ArchivePreviewQueueOptions['respond'];
	readonly #concurrency: number;
	readonly #cacheSize: number;
	readonly #cacheBytes: number;
	readonly #cache = new Map<string, Blob>();
	#cachedBytes = 0;
	readonly #jobs = new Map<string, Job>();
	readonly #pending: Job[] = [];
	#activeCount = 0;

	constructor(options: ArchivePreviewQueueOptions) {
		this.#load = options.load;
		this.#respond = options.respond;
		this.#concurrency = options.concurrency ?? ARCHIVE_PREVIEW_CONCURRENCY;
		this.#cacheSize = options.cacheSize ?? ARCHIVE_PREVIEW_CACHE_SIZE;
		this.#cacheBytes = options.cacheBytes ?? ARCHIVE_PREVIEW_CACHE_BYTES;
	}

	enqueue(request: ArchivePreviewRequest): void {
		const key = previewKey(request);
		const cached = this.#cache.get(key);
		if (cached) {
			this.#cache.delete(key);
			this.#cache.set(key, cached);
			this.#respond({ type: 'result', requestId: request.requestId, entryId: request.entryId, blob: cached });
			return;
		}

		const subscriber: Subscriber = request;
		const existing = this.#jobs.get(key);
		if (existing) {
			existing.subscribers.set(request.requestId, subscriber);
			return;
		}

		const job: Job = { key, request, subscribers: new Map([[request.requestId, subscriber]]) };
		this.#jobs.set(key, job);
		this.#pending.push(job);
		this.#drain();
	}

	cancelConsumer(consumerId: string): void {
		for (const job of this.#jobs.values()) {
			for (const subscriber of job.subscribers.values()) {
				if (subscriber.consumerId !== consumerId) continue;
				job.subscribers.delete(subscriber.requestId);
				this.#respond({ type: 'cancelled', requestId: subscriber.requestId, entryId: subscriber.entryId });
			}
			if (job.subscribers.size === 0) {
				this.#jobs.delete(job.key);
				job.controller?.abort();
			}
		}
		this.#removeOrphanedPendingJobs();
	}

	clearContext(archiveId: string, encryptionKey: string): void {
		for (const [key] of this.#cache) {
			const [cachedArchiveId, , cachedEncryptionKey] = JSON.parse(key) as [string, string, string];
			if (cachedArchiveId === archiveId && cachedEncryptionKey === encryptionKey) this.#deleteCached(key);
		}
		for (const job of this.#jobs.values()) {
			if (job.request.archiveId === archiveId && job.request.encryptionKey === encryptionKey) this.#cancelJob(job);
		}
		this.#removeOrphanedPendingJobs();
	}

	evict(archiveId: string, entryId: string, encryptionKey: string): void {
		this.#deleteCached(previewKey({ archiveId, entryId, encryptionKey }));
	}

	clearAll(): void {
		this.#cache.clear();
		this.#cachedBytes = 0;
		for (const job of this.#jobs.values()) this.#cancelJob(job);
		this.#removeOrphanedPendingJobs();
	}

	#cancelJob(job: Job): void {
		for (const subscriber of job.subscribers.values()) {
			this.#respond({ type: 'cancelled', requestId: subscriber.requestId, entryId: subscriber.entryId });
		}
		job.subscribers.clear();
		this.#jobs.delete(job.key);
		job.controller?.abort();
	}

	#removeOrphanedPendingJobs(): void {
		for (let index = this.#pending.length - 1; index >= 0; index--) {
			const job = this.#pending[index]!;
			if (job.subscribers.size !== 0) continue;
			this.#pending.splice(index, 1);
			if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
		}
	}

	#drain(): void {
		while (this.#activeCount < this.#concurrency) {
			const job = this.#pending.shift();
			if (!job) return;
			if (job.subscribers.size === 0) {
				this.#jobs.delete(job.key);
				continue;
			}
			void this.#run(job);
		}
	}

	async #run(job: Job): Promise<void> {
		this.#activeCount++;
		job.controller = new AbortController();
		try {
			const blob = await this.#load(job.request, job.controller.signal);
			if (job.subscribers.size === 0) return;
			const previous = this.#cache.get(job.key);
			if (previous) this.#cachedBytes -= previous.size;
			this.#cache.set(job.key, blob);
			this.#cachedBytes += blob.size;
			while (this.#cache.size > this.#cacheSize || this.#cachedBytes > this.#cacheBytes) {
				const oldestKey = this.#cache.keys().next().value;
				if (oldestKey === undefined) break;
				this.#deleteCached(oldestKey);
			}
			for (const subscriber of job.subscribers.values()) {
				this.#respond({ type: 'result', requestId: subscriber.requestId, entryId: subscriber.entryId, blob });
			}
		} catch (error) {
			if (job.subscribers.size === 0) return;
			const message = error instanceof Error ? error.message : String(error);
			for (const subscriber of job.subscribers.values()) {
				this.#respond({ type: 'error', requestId: subscriber.requestId, entryId: subscriber.entryId, error: message });
			}
		} finally {
			if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
			this.#activeCount--;
			this.#drain();
		}
	}

	#deleteCached(key: string): void {
		const blob = this.#cache.get(key);
		if (!blob) return;
		this.#cache.delete(key);
		this.#cachedBytes -= blob.size;
	}
}
