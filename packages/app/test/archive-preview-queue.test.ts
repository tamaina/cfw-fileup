import { describe, expect, test, vi } from 'vitest';
import { ArchivePreviewQueue } from '../src/client/workers/archive-preview-queue';
import type { ArchivePreviewRequest, ArchivePreviewWorkerResponse } from '../src/client/workers/archive-preview-worker-types';

function request(requestId: string, entryId = requestId, consumerId = 'consumer'): ArchivePreviewRequest {
	return {
		type: 'preview',
		requestId,
		consumerId,
		archiveId: 'archive',
		entryId,
		url: `/entry/${entryId}`,
		encryptionKey: 'key',
		mimeType: 'image/png',
		headers: {},
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('ArchivePreviewQueue', () => {
	test('limits concurrency and continues draining the queue', async () => {
		let active = 0;
		let maximumActive = 0;
		const releases: Array<() => void> = [];
		const responses: ArchivePreviewWorkerResponse[] = [];
		const queue = new ArchivePreviewQueue({
			concurrency: 3,
			load: async () => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				await new Promise<void>(resolve => releases.push(resolve));
				active--;
				return new Blob(['preview']);
			},
			respond: message => responses.push(message),
		});

		for (let index = 0; index < 5; index++) queue.enqueue(request(String(index)));
		expect(active).toBe(3);
		releases.splice(0, 3).forEach(release => release());
		await flush();
		expect(maximumActive).toBe(3);
		expect(active).toBe(2);
		releases.splice(0).forEach(release => release());
		await flush();
		expect(responses.filter(message => message.type === 'result')).toHaveLength(5);
	});

	test('deduplicates in-flight requests and serves later requests from cache', async () => {
		const load = vi.fn(async () => new Blob(['preview']));
		const responses: ArchivePreviewWorkerResponse[] = [];
		const queue = new ArchivePreviewQueue({ load, respond: message => responses.push(message) });

		queue.enqueue(request('first', 'same'));
		queue.enqueue(request('second', 'same'));
		await flush();
		queue.enqueue(request('third', 'same'));

		expect(load).toHaveBeenCalledTimes(1);
		expect(responses.map(message => message.requestId)).toEqual(['first', 'second', 'third']);
	});

	test('evicts the least recently used cached blob', async () => {
		const load = vi.fn(async (item: ArchivePreviewRequest) => new Blob([item.entryId]));
		const queue = new ArchivePreviewQueue({ cacheSize: 2, load, respond: () => {} });

		queue.enqueue(request('1', 'one'));
		await flush();
		queue.enqueue(request('2', 'two'));
		await flush();
		queue.enqueue(request('touch', 'one'));
		queue.enqueue(request('3', 'three'));
		await flush();
		queue.enqueue(request('reload', 'two'));
		await flush();

		expect(load).toHaveBeenCalledTimes(4);
	});

	test('limits cached blobs by their total byte size', async () => {
		const load = vi.fn(async () => new Blob(['12345678']));
		const queue = new ArchivePreviewQueue({ cacheSize: 10, cacheBytes: 12, load, respond: () => {} });

		queue.enqueue(request('1', 'one'));
		await flush();
		queue.enqueue(request('2', 'two'));
		await flush();
		queue.enqueue(request('reload', 'one'));
		await flush();

		expect(load).toHaveBeenCalledTimes(3);
	});

	test('cancels one consumer without cancelling shared work for another', async () => {
		let release!: () => void;
		const load = vi.fn(async () => {
			await new Promise<void>(resolve => { release = resolve; });
			return new Blob(['preview']);
		});
		const responses: ArchivePreviewWorkerResponse[] = [];
		const queue = new ArchivePreviewQueue({ load, respond: message => responses.push(message) });
		queue.enqueue(request('first', 'same', 'leaving'));
		queue.enqueue(request('second', 'same', 'staying'));

		queue.cancelConsumer('leaving');
		release();
		await flush();

		expect(responses).toEqual([
			{ type: 'cancelled', requestId: 'first', entryId: 'same' },
			expect.objectContaining({ type: 'result', requestId: 'second', entryId: 'same' }),
		]);
	});

	test('aborts work with no remaining consumers and accepts a fresh request', async () => {
		const signals: AbortSignal[] = [];
		const load = vi.fn(async (_item: ArchivePreviewRequest, signal: AbortSignal) => {
			signals.push(signal);
			if (signals.length === 1) {
				await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
			}
			return new Blob(['preview']);
		});
		const responses: ArchivePreviewWorkerResponse[] = [];
		const queue = new ArchivePreviewQueue({ load, respond: message => responses.push(message) });

		queue.enqueue(request('cancelled', 'same', 'leaving'));
		queue.cancelConsumer('leaving');
		queue.enqueue(request('fresh', 'same', 'staying'));
		await flush();

		expect(signals[0]?.aborted).toBe(true);
		expect(load).toHaveBeenCalledTimes(2);
		expect(responses).toContainEqual(expect.objectContaining({ type: 'result', requestId: 'fresh' }));
	});

	test('does not cache failures and continues with later jobs', async () => {
		const load = vi.fn(async (item: ArchivePreviewRequest) => {
			if (item.entryId === 'bad') throw new Error('decrypt failed');
			return new Blob(['preview']);
		});
		const responses: ArchivePreviewWorkerResponse[] = [];
		const queue = new ArchivePreviewQueue({ concurrency: 1, load, respond: message => responses.push(message) });

		queue.enqueue(request('bad-1', 'bad'));
		queue.enqueue(request('good', 'good'));
		await flush();
		queue.enqueue(request('bad-2', 'bad'));
		await flush();

		expect(load).toHaveBeenCalledTimes(3);
		expect(responses).toEqual([
			{ type: 'error', requestId: 'bad-1', entryId: 'bad', error: 'decrypt failed' },
			expect.objectContaining({ type: 'result', requestId: 'good' }),
			{ type: 'error', requestId: 'bad-2', entryId: 'bad', error: 'decrypt failed' },
		]);
	});
});
