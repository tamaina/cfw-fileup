import { createRangeCache, type RangeCache, type StoredRange } from './download-range-cache';

export class DownloadStalledError extends Error {
	constructor(timeoutMs: number) {
		super(`Download stalled: no data received for ${timeoutMs}ms`);
		this.name = 'DownloadStalledError';
	}
}

export type RetryOptions = {
	readonly maxAttempts: number;
	readonly shouldRetry: (error: unknown) => boolean;
	readonly delayMs: (failedAttempt: number) => number;
	readonly onRetry?: (error: unknown, failedAttempt: number, delayMs: number) => void;
	readonly signal?: AbortSignal;
};

export async function runWithRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		try {
			return await operation(attempt);
		} catch (error) {
			if (attempt >= options.maxAttempts || !options.shouldRetry(error)) throw error;
			const delayMs = options.delayMs(attempt);
			options.onRetry?.(error, attempt, delayMs);
			if (delayMs > 0) await abortableDelay(delayMs, options.signal);
		}
	}
	throw new Error('Retry loop ended unexpectedly');
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, delayMs);

		function onAbort(): void {
			clearTimeout(timeoutId);
			reject(signal?.reason);
		}

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export function withInactivityTimeout<T>(stream: ReadableStream<T>, timeoutMs: number, onStall?: () => void): ReadableStream<T> {
	const reader = stream.getReader();
	return new ReadableStream<T>({
		async pull(controller) {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					reader.read(),
					new Promise<never>((_resolve, reject) => {
						timeoutId = setTimeout(() => {
							onStall?.();
							reject(new DownloadStalledError(timeoutMs));
						}, timeoutMs);
					}),
				]);
				if (result.done) {
					controller.close();
				} else {
					controller.enqueue(result.value);
				}
			} catch (error) {
				void reader.cancel(error).catch(() => {});
				throw error;
			} finally {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	}, { highWaterMark: 0 });
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const timeoutController = new AbortController();
	const sourceSignal = init.signal;
	if (sourceSignal?.aborted) throw sourceSignal.reason;
	const signal = sourceSignal === null || sourceSignal === undefined
		? timeoutController.signal
		: AbortSignal.any([sourceSignal, timeoutController.signal]);
	const timeoutId = setTimeout(() => timeoutController.abort(new DownloadStalledError(timeoutMs)), timeoutMs);
	try {
		return await fetch(url, { ...init, signal });
	} finally {
		clearTimeout(timeoutId);
	}
}

export type RangedDownloadOptions = {
	readonly maxBufferedRanges?: number;
	readonly staging?: 'opfs';
	readonly readChunkSize?: number;
	readonly onCleanup?: (cleanup: Promise<void>) => void;
	readonly onQueue?: (bytes: number, disk: boolean) => void;
	readonly cacheFactory?: () => Promise<RangeCache>;
	readonly acquireNetwork?: () => Promise<(bytes: number, durationMs: number) => void>;
	readonly rangeSize: number;
	readonly maxAttempts: number;
	readonly requestTimeoutMs: number;
	readonly inactivityTimeoutMs: number;
	readonly onMetadata?: (totalBytes: number) => void;
	readonly onRangeCommitted?: (committedBytes: number, totalBytes: number) => void;
	readonly onStall?: (rangeStart: number, attempt: number) => void;
	readonly onRetry?: (error: unknown, rangeStart: number, nextAttempt: number, delayMs: number) => void;
};

type RangeChunk = {
	readonly data: StoredRange;
	readonly totalBytes: number;
	readonly validator: string | null;
};

class RangeResponseError extends Error {
	constructor(message: string, readonly retryable: boolean) {
		super(message);
		this.name = 'RangeResponseError';
	}
}

export function createRangedDownloadStream(url: string, init: RequestInit, options: RangedDownloadOptions): ReadableStream<Uint8Array<ArrayBuffer>> {
	const abort = new AbortController();
	const wakeups = new Set<() => void>();
	const wake = () => { for (const resolve of wakeups) resolve(); wakeups.clear(); };
	const wait = () => new Promise<void>(resolve => wakeups.add(resolve));
	const queue: RangeChunk[] = [];
	let cache: RangeCache | undefined;
	let producer: Promise<void> | undefined;
	let total: number | undefined;
	let nextOffset = 0;
	let readOffset = 0;
	let committed = 0;
	let done = false;
	let failure: unknown;
	let finalizing: Promise<void> | undefined;
	let resolveCleanup!: () => void;
	let rejectCleanup!: (error: unknown) => void;
	const cleanup = new Promise<void>((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject; });
	void cleanup.catch(() => {});
	options.onCleanup?.(cleanup);
	const reportQueue = () => options.onQueue?.(queue.reduce((sum, item) => sum + item.data.size, 0), cache?.disk ?? false);
	const forwardAbort = () => abort.abort(init.signal?.reason);

	function finalize(): Promise<void> {
		if (finalizing) return finalizing;
		finalizing = Promise.resolve().then(async () => {
			abort.abort();
			wake();
			await producer;
			try {
				for (const chunk of queue.splice(0)) await chunk.data.dispose();
			} finally {
				await cache?.close();
				init.signal?.removeEventListener('abort', forwardAbort);
				reportQueue();
			}
		});
		void finalizing.then(resolveCleanup, rejectCleanup);
		return finalizing;
	}

	async function produce(): Promise<void> {
		try {
			cache = await (options.cacheFactory?.() ?? createRangeCache(options.staging === 'opfs'));
			const window = cache.disk ? Math.max(1, Math.min(4, options.maxBufferedRanges ?? 4))
				: Math.max(1, Math.min(options.maxBufferedRanges ?? 1, Math.floor(32 * 1024 * 1024 / options.rangeSize)));
			let validator: string | null = null;
			while (total === undefined || nextOffset < total) {
				abort.signal.throwIfAborted();
				while (queue.length >= window) { await wait(); abort.signal.throwIfAborted(); }
				const start = nextOffset;
				const chunk = await runWithRetry(async attempt => {
					abort.signal.throwIfAborted();
					const acquire = options.acquireNetwork?.().then(release => {
						if (abort.signal.aborted) release(0, 0);
						return release;
					});
					const release = acquire ? await withAbort(acquire, abort.signal) : undefined;
					try {
						abort.signal.throwIfAborted();
						return await fetchRange(url, { ...init, signal: abort.signal }, start, start + options.rangeSize - 1, validator, attempt, options, cache!, release);
					} finally { release?.(0, 0); }
				}, {
					maxAttempts: options.maxAttempts,
					shouldRetry: error => !abort.signal.aborted && isRetryableRangeError(error),
					delayMs: attempt => Math.min(2 ** (attempt - 1) * 1000, 16_000),
					onRetry: (error, attempt, delay) => options.onRetry?.(error, start, attempt + 1, delay), signal: abort.signal,
				});
				queue.push(chunk); // Include it in cleanup even if validation/abort fails.
				abort.signal.throwIfAborted();
				if (total === undefined) {
					if (chunk.validator === null && chunk.data.size < chunk.totalBytes) throw new RangeResponseError('A strong ETag or Last-Modified validator is required for a multi-range download', false);
					total = chunk.totalBytes;
					validator = chunk.validator;
					options.onMetadata?.(total);
				} else if (chunk.totalBytes !== total || chunk.validator !== validator) {
					throw new RangeResponseError('Download representation changed between range requests', false);
				}
				nextOffset += chunk.data.size;
				reportQueue();
				wake();
			}
		} catch (error) { failure = error; } finally { done = true; wake(); }
	}

	return new ReadableStream<Uint8Array<ArrayBuffer>>({
		start() {
			abort.signal.addEventListener('abort', () => { wake(); void finalize().catch(() => {}); }, { once: true });
			if (init.signal?.aborted) forwardAbort();
			else init.signal?.addEventListener('abort', forwardAbort, { once: true });
		},
		async pull(controller) {
			try {
				abort.signal.throwIfAborted();
				producer ??= produce();
				while (!queue.length && !done) { await wait(); abort.signal.throwIfAborted(); }
				if (failure) throw failure;
				if (!queue.length) { await finalize(); controller.close(); return; }
				const chunk = queue[0];
				const length = Math.min(options.readChunkSize ?? options.rangeSize, chunk.data.size - readOffset);
				const bytes = await chunk.data.read(readOffset, length);
				abort.signal.throwIfAborted();
				if (bytes.length !== length) throw new Error('Truncated staged range');
				readOffset += length;
				committed += length;
				if (readOffset === chunk.data.size) {
					await chunk.data.dispose();
					queue.shift(); readOffset = 0; reportQueue(); wake();
				}
				options.onRangeCommitted?.(committed, total ?? 0);
				if (bytes.length) controller.enqueue(bytes);
				else { await finalize(); controller.close(); }
			} catch (error) { await finalize().catch(() => {}); throw error; }
		},
		cancel() { return finalize(); },
	}, { highWaterMark: 0 });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
		if (signal.aborted) abort();
	});
}

async function fetchRange(
	url: string,
	init: RequestInit,
	start: number,
	end: number,
	validator: string | null,
	attempt: number,
	options: RangedDownloadOptions,
	cache: RangeCache,
	onReceived?: (bytes: number, durationMs: number) => void,
): Promise<RangeChunk> {
	const headers = new Headers(init.headers);
	headers.set('Range', `bytes=${start}-${end}`);
	if (validator !== null) headers.set('If-Range', validator);

	const response = await fetchWithTimeout(url, { ...init, headers }, options.requestTimeoutMs);
	if (response.status === 416 && start === 0 && response.headers.get('Content-Range') === 'bytes */0') {
		await response.body?.cancel();
		const sink = await cache.create(0);
		try { return { data: await sink.finish(), totalBytes: 0, validator: selectIfRangeValidator(response.headers) }; } catch (error) { await sink.abort(); throw new RangeStorageError(error); }
	}
	if (response.status !== 206) {
		await response.body?.cancel().catch(() => {});
		const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
		throw new RangeResponseError(`Expected HTTP 206 for bytes=${start}-${end}, received ${response.status}`, retryable);
	}
	if (response.body === null) throw new RangeResponseError('Range response body is empty', false);

	const contentRange = parseContentRange(response.headers.get('Content-Range'));
	if (contentRange === null || contentRange.start !== start || contentRange.end !== Math.min(end, contentRange.total - 1)) {
		await response.body.cancel().catch(() => {});
		throw new RangeResponseError(`Invalid Content-Range for bytes=${start}-${end}`, false);
	}
	const expectedLength = contentRange.end - contentRange.start + 1;
	let sink;
	try { sink = await cache.create(expectedLength); } catch (error) { await response.body.cancel().catch(() => {}); throw new RangeStorageError(error); }
	let received = 0;
	let receiveMs = 0;
	const monitored = withInactivityTimeout(response.body, options.inactivityTimeoutMs, () => options.onStall?.(start, attempt));
	const reader = monitored.getReader();
	try {
		while (true) {
			const started = performance.now();
			const result = await reader.read();
			receiveMs += performance.now() - started;
			if (result.done) break;
			if (received + result.value.byteLength > expectedLength) {
				throw new RangeResponseError('Range response exceeded Content-Range length', false);
			}
			try { await sink.write(result.value); } catch (error) { throw new RangeStorageError(error); }
			received += result.value.byteLength;
		}
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		await sink.abort();
		throw error;
	} finally {
		reader.releaseLock();
	}
	if (received !== expectedLength) {
		await sink.abort();
		throw new RangeResponseError(`Incomplete range response: expected ${expectedLength} bytes, received ${received}`, true);
	}

	let data: StoredRange;
	try { data = await sink.finish(); } catch (error) { await sink.abort(); throw new RangeStorageError(error); }
	onReceived?.(received, receiveMs);
	return {
		data,
		totalBytes: contentRange.total,
		validator: selectIfRangeValidator(response.headers),
	};
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
	const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
	if (!match) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	const total = Number(match[3]);
	if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
	return { start, end, total };
}

function selectIfRangeValidator(headers: Headers): string | null {
	const etag = headers.get('ETag');
	if (etag !== null && !etag.startsWith('W/')) return etag;
	return headers.get('Last-Modified');
}

function isRetryableRangeError(error: unknown): boolean {
	if (error instanceof RangeResponseError) return error.retryable;
	if (error instanceof DownloadStalledError || error instanceof TypeError) return true;
	return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NetworkError');
}

/** Disk failures must not trigger another GET/retry of the same range. */
class RangeStorageError extends Error {
	constructor(cause: unknown) {
		super(`Range buffer storage failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
	}
}
