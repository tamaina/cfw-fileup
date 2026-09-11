/// <reference lib="webworker" />
import { afterEach, describe, expect, test, vi } from 'vitest';
import { installStreamDownloads } from '../src/sw/stream-download';

function setup() {
	const listeners = new Map<string, (event: any) => void>();
	installStreamDownloads({ location: { origin: 'https://example.test' }, addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn) } as unknown as ServiceWorkerGlobalScope);
	return {
		register(stream: ReadableStream<Uint8Array>, filename = '日本語.tar', origin = 'https://example.test') {
			const port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as null | (() => void) };
			listeners.get('message')!({ data: { type: 'stream-download-v1', stream, filename }, source: { url: origin + '/' }, ports: [port] });
			return { port, path: port.postMessage.mock.calls[0]?.[0].path };
		},
		fetch(path: string, method = 'GET') {
			let response: Response | undefined;
			listeners.get('fetch')!({ request: new Request('https://example.test' + path, { method }), respondWith: (value: Response) => { response = value; } });
			return response!;
		},
	};
}

afterEach(() => vi.useRealTimers());

describe('SW stream downloads', () => {
	test('preserves bytes and filename, consumes URL once, ignores unrelated requests', async () => {
		const sw = setup();
		const { path } = sw.register(new Blob(['payload']).stream());
		const response = sw.fetch(path);
		expect(await response.text()).toBe('payload');
		expect(response.headers.get('Content-Disposition')).toContain(encodeURIComponent('日本語.tar'));
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(sw.fetch(path).status).toBe(404);
		expect(sw.fetch('/share-target', 'POST')).toBeUndefined();
	});

	test('expiry cancels abandoned producer and rejects stale URL', async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const sw = setup();
		const { path } = sw.register(new ReadableStream({ cancel }));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(cancel).toHaveBeenCalled();
		expect(sw.fetch(path).status).toBe(404);
	});

	test('browser cancellation reaches the producer', async () => {
		const cancel = vi.fn();
		const sw = setup();
		const { path } = sw.register(new ReadableStream({ cancel }));
		await sw.fetch(path).body!.cancel('user cancelled');
		expect(cancel).toHaveBeenCalledWith('user cancelled');
	});

	test('producer failure makes the response fail instead of completing a partial file', async () => {
		const sw = setup();
		const { path, port } = sw.register(new ReadableStream());
		const response = sw.fetch(path);
		port.onmessage!();
		await expect(response.text()).rejects.toThrow('Download failed');
	});

	test('rejects messages from another origin', () => {
		const sw = setup();
		const { path } = sw.register(new ReadableStream(), 'file', 'https://other.test');
		expect(path).toBeUndefined();
	});
});

describe('save target fallback', () => {
	afterEach(() => vi.unstubAllGlobals());

	test('uses picker when SW does not control the page', async () => {
		const fileHandle = {};
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('window', { showSaveFilePicker: vi.fn().mockResolvedValue(fileHandle) });
		const { resolveSaveTarget } = await import('../src/client/utils/save-file');
		expect(await resolveSaveTarget('file.tar', 'application/x-tar')).toEqual({ kind: 'picker', fileHandle });
	});

	test('uses OPFS with quota check when neither SW nor picker is available', async () => {
		vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(), estimate: vi.fn().mockResolvedValue({ quota: 100, usage: 0 }) } });
		vi.stubGlobal('window', {});
		const { resolveSaveTarget, StorageQuotaExceededError } = await import('../src/client/utils/save-file');
		expect(await resolveSaveTarget('file.tar', 'application/x-tar', 50)).toEqual({ kind: 'opfs' });
		await expect(resolveSaveTarget('file.tar', 'application/x-tar', 200)).rejects.toBeInstanceOf(StorageQuotaExceededError);
	});

	test('seek output bypasses SW and picker cancellation stays cancelled', async () => {
		const postMessage = vi.fn();
		vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });
		vi.stubGlobal('window', { showSaveFilePicker: vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError')) });
		const { resolveSaveTarget, DownloadCancelledError } = await import('../src/client/utils/save-file');
		await expect(resolveSaveTarget('movie.mp4', 'video/mp4', undefined, false)).rejects.toBeInstanceOf(DownloadCancelledError);
		expect(postMessage).not.toHaveBeenCalled();
	});
});
