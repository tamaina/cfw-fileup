import { describe, expect, test, vi } from 'vitest';
import { DownloadStalledError, fetchWithTimeout, runWithRetry, withInactivityTimeout } from '../src/client/workers/download-resilience';

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
