import { describe, expect, test, vi } from 'vitest';
import { createRangedDownloadStream, DownloadStalledError, fetchWithTimeout, runWithRetry, withInactivityTimeout } from '../src/client/workers/download-resilience';

describe('runWithRetry', () => {
	test('retries transient failures and returns the successful attempt', async () => {
		const operation = vi.fn(async (attempt: number) => {
			if (attempt < 3) throw new TypeError('network failure');
			return attempt;
		});
		const retries: number[] = [];

		const result = await runWithRetry(operation, {
			maxAttempts: 4,
			shouldRetry: error => error instanceof TypeError,
			delayMs: () => 0,
			onRetry: (_error, attempt) => retries.push(attempt),
		});

		expect(result).toBe(3);
		expect(operation).toHaveBeenCalledTimes(3);
		expect(retries).toEqual([1, 2]);
	});

	test('does not retry permanent failures', async () => {
		const error = new Error('permanent');
		const operation = vi.fn().mockRejectedValue(error);

		await expect(runWithRetry(operation, {
			maxAttempts: 4,
			shouldRetry: () => false,
			delayMs: () => 0,
		})).rejects.toBe(error);
		expect(operation).toHaveBeenCalledTimes(1);
	});
});

describe('withInactivityTimeout', () => {
	test('passes through data while the source makes progress', async () => {
		const stream = new ReadableStream<number>({
			start(controller) {
				controller.enqueue(1);
				controller.enqueue(2);
				controller.close();
			},
		});

		const values: number[] = [];
		for await (const value of withInactivityTimeout(stream, 100)) values.push(value);
		expect(values).toEqual([1, 2]);
	});

	test('errors and cancels the source when no data arrives', async () => {
		let cancelled = false;
		const stream = new ReadableStream<number>({
			pull() {
				return new Promise(() => {});
			},
			cancel() {
				cancelled = true;
			},
		});
		const reader = withInactivityTimeout(stream, 5).getReader();

		await expect(reader.read()).rejects.toBeInstanceOf(DownloadStalledError);
		expect(cancelled).toBe(true);
	});
});

describe('fetchWithTimeout', () => {
	test('aborts a request that does not receive response headers', async () => {
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
		}));
		vi.stubGlobal('fetch', fetchMock);

		await expect(fetchWithTimeout('/file', {}, 5)).rejects.toBeInstanceOf(DownloadStalledError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});

describe('createRangedDownloadStream', () => {
	test('retries an incomplete range from its beginning before committing it', async () => {
		const requests: Array<{ range: string | null; ifRange: string | null }> = [];
		let firstRangeAttempts = 0;
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const range = headers.get('Range');
			requests.push({ range, ifRange: headers.get('If-Range') });
			if (range === 'bytes=0-3') {
				firstRangeAttempts++;
				return Promise.resolve(new Response(
					new Uint8Array(firstRangeAttempts === 1 ? [0, 1] : [0, 1, 2, 3]),
					{ status: 206, headers: { 'Content-Range': 'bytes 0-3/7', ETag: '"version-1"' } },
				));
			}
			return Promise.resolve(new Response(
				new Uint8Array([4, 5, 6]),
				{ status: 206, headers: { 'Content-Range': 'bytes 4-6/7', ETag: '"version-1"' } },
			));
		});
		vi.stubGlobal('fetch', fetchMock);

		const committed: number[] = [];
		const stream = createRangedDownloadStream('/file', {}, {
			rangeSize: 4,
			maxAttempts: 2,
			requestTimeoutMs: 100,
			inactivityTimeoutMs: 100,
			onRangeCommitted: bytes => committed.push(bytes),
		});
		const chunks: number[] = [];
		for await (const chunk of stream) chunks.push(...chunk);

		expect(chunks).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(committed).toEqual([4, 7]);
		expect(requests).toEqual([
			{ range: 'bytes=0-3', ifRange: null },
			{ range: 'bytes=0-3', ifRange: null },
			{ range: 'bytes=4-7', ifRange: '"version-1"' },
		]);
		vi.unstubAllGlobals();
	});

	test('rejects a full response so different representations cannot be mixed', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([0, 1]), { status: 200 })));
		const reader = createRangedDownloadStream('/file', {}, {
			rangeSize: 4,
			maxAttempts: 2,
			requestTimeoutMs: 100,
			inactivityTimeoutMs: 100,
		}).getReader();

		await expect(reader.read()).rejects.toThrow(/Expected HTTP 206/);
		vi.unstubAllGlobals();
	});
});
