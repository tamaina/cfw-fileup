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
};

export async function runWithRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		try {
			return await operation(attempt);
		} catch (error) {
			if (attempt >= options.maxAttempts || !options.shouldRetry(error)) throw error;
			const delayMs = options.delayMs(attempt);
			options.onRetry?.(error, attempt, delayMs);
			if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
		}
	}
	throw new Error('Retry loop ended unexpectedly');
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
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(new DownloadStalledError(timeoutMs)), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
}
