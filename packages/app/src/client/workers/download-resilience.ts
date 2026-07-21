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
	});
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

type RangedDownloadOptions = {
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
	readonly bytes: Uint8Array<ArrayBuffer>;
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
	let offset = 0;
	let totalBytes: number | null = null;
	let validator: string | null = null;
	const abortController = new AbortController();
	const sourceSignal = init.signal;
	const forwardAbort = (): void => abortController.abort(sourceSignal?.reason);
	if (sourceSignal?.aborted) forwardAbort();
	else sourceSignal?.addEventListener('abort', forwardAbort, { once: true });
	const finish = (): void => sourceSignal?.removeEventListener('abort', forwardAbort);

	return new ReadableStream<Uint8Array<ArrayBuffer>>({
		async pull(controller) {
			try {
				if (totalBytes !== null && offset >= totalBytes) {
					finish();
					controller.close();
					return;
				}

				const rangeStart = offset;
				const rangeEnd = rangeStart + options.rangeSize - 1;
				const chunk = await runWithRetry(
					attempt => fetchRange(url, { ...init, signal: abortController.signal }, rangeStart, rangeEnd, validator, attempt, options),
					{
						maxAttempts: options.maxAttempts,
						shouldRetry: error => !abortController.signal.aborted && isRetryableRangeError(error),
						delayMs: failedAttempt => Math.min(2 ** (failedAttempt - 1) * 1000, 16_000),
						onRetry(error, failedAttempt, delayMs) {
							options.onRetry?.(error, rangeStart, failedAttempt + 1, delayMs);
						},
						signal: abortController.signal,
					},
				);

				if (totalBytes === null) {
					if (chunk.validator === null && chunk.bytes.byteLength < chunk.totalBytes) {
						throw new RangeResponseError('A strong ETag or Last-Modified validator is required for a multi-range download', false);
					}
					totalBytes = chunk.totalBytes;
					validator = chunk.validator;
					options.onMetadata?.(totalBytes);
				} else if (chunk.totalBytes !== totalBytes) {
					throw new RangeResponseError('Download size changed between range requests', false);
				}

				controller.enqueue(chunk.bytes);
				offset += chunk.bytes.byteLength;
				options.onRangeCommitted?.(offset, totalBytes);
			} catch (error) {
				finish();
				throw error;
			}
		},
		cancel(reason) {
			finish();
			abortController.abort(reason);
		},
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
): Promise<RangeChunk> {
	const headers = new Headers(init.headers);
	headers.set('Range', `bytes=${start}-${end}`);
	if (validator !== null) headers.set('If-Range', validator);

	const response = await fetchWithTimeout(url, { ...init, headers }, options.requestTimeoutMs);
	if (response.status !== 206) {
		await response.body?.cancel().catch(() => {});
		const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
		throw new RangeResponseError(`Expected HTTP 206 for bytes=${start}-${end}, received ${response.status}`, retryable);
	}
	if (response.body === null) throw new RangeResponseError('Range response body is empty', false);

	const contentRange = parseContentRange(response.headers.get('Content-Range'));
	if (contentRange === null || contentRange.start !== start || contentRange.end > end) {
		await response.body.cancel().catch(() => {});
		throw new RangeResponseError(`Invalid Content-Range for bytes=${start}-${end}`, false);
	}
	const expectedLength = contentRange.end - contentRange.start + 1;
	const bytes = new Uint8Array(expectedLength);
	let received = 0;
	const monitored = withInactivityTimeout(response.body, options.inactivityTimeoutMs, () => options.onStall?.(start, attempt));
	const reader = monitored.getReader();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			if (received + result.value.byteLength > expectedLength) {
				throw new RangeResponseError('Range response exceeded Content-Range length', false);
			}
			bytes.set(result.value, received);
			received += result.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (received !== expectedLength) {
		throw new RangeResponseError(`Incomplete range response: expected ${expectedLength} bytes, received ${received}`, true);
	}

	return {
		bytes,
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
