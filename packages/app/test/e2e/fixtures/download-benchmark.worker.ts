import { createRangedDownloadStream } from '../../../src/client/workers/download-resilience';
import { DownloadPipeline, parallelBgzf, parallelDecrypt } from '../../../src/client/workers/download-pipeline';
import { createDecryptedTarStream } from '../../../src/client/workers/decrypted-tar';
import { importAesCtrKey } from '../../../src/shared/encryption';

declare global { var benchmarkCpuMs: number; }
self.onmessage = async (event: MessageEvent<{
	mode: string; kind: string; url: string; baseline: string; port?: MessagePort; slowSave: boolean;
}>) => {
	const request = event.data;
	let pipeline: DownloadPipeline | undefined;
	try {
		globalThis.benchmarkCpuMs = 0;
		const started = performance.now();
		let networkMs = 0;
		let requestCount = 0;
		let peakDiskBytes = 0;
		let writeMs = 0;
		let outputBytes = 0;
		const outputs: Uint8Array<ArrayBuffer>[] = [];
		const baselineUrl = URL.createObjectURL(new Blob([request.baseline], { type: 'text/javascript' }));
		const baseline = await import(/* @vite-ignore */ baselineUrl);
		URL.revokeObjectURL(baselineUrl);
		if (request.port) { pipeline = new DownloadPipeline(request.port); await pipeline.start(); }
		const key = await importAesCtrKey(new Uint8Array(32).fill(9));
		let stream = createRangedDownloadStream(request.url, { signal: pipeline?.abort.signal }, {
			rangeSize: !pipeline && request.kind === 'archive' ? 4 * 1024 * 1024 : 32 * 1024 * 1024,
			staging: pipeline ? 'opfs' : undefined,
			readChunkSize: pipeline ? 1024 * 1024 : undefined,
			onCleanup: cleanup => pipeline?.trackCleanup(cleanup),
			onQueue: (bytes, disk) => { if (disk) peakDiskBytes = Math.max(peakDiskBytes, bytes); },
			maxBufferedRanges: pipeline ? 4 : 1, maxAttempts: 1, requestTimeoutMs: 30_000, inactivityTimeoutMs: 30_000,
			acquireNetwork: async () => {
				requestCount++;
				if (pipeline) return pipeline.network();
				let released = false;
				return (_bytes, ms) => { if (!released) { released = true; networkMs += ms; } };
			},
		});
		if (request.kind === 'encrypted') stream = pipeline ? parallelDecrypt(stream, key, pipeline, true) : stream.pipeThrough(baseline.createAesCtrDecryptTransform(key));
		else stream = pipeline ? parallelBgzf(stream, pipeline, true) : stream.pipeThrough(baseline.createBgzfDecompressor());
		if (request.kind === 'archive') stream = createDecryptedTarStream(stream, key, () => {}, () => {}, (source, key) => pipeline ? parallelDecrypt(source, key, pipeline) : source.pipeThrough(baseline.createAesCtrDecryptTransform(key)));
		const reader = stream.getReader();
		let saveDeadline = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const writeStart = performance.now();
			if (request.slowSave) {
				saveDeadline = Math.max(saveDeadline, writeStart) + value.length / (8 * 1024 * 1024 / 1000);
				const delay = saveDeadline - performance.now();
				if (delay >= 1) await new Promise(resolve => setTimeout(resolve, delay));
			}
			// Measurement harness retains output only for correctness hashing, outside pipeline budget.
			outputs.push(value);
			outputBytes += value.length;
			writeMs += performance.now() - writeStart;
		}
		reader.releaseLock();
		await pipeline?.finish();
		const totalMs = performance.now() - started;
		const output = new Uint8Array(await new Blob(outputs).arrayBuffer());
		const payload = request.kind === 'archive' ? output.subarray(512, output.length - 1024 - (output.length - 1024 - 512) % 512) : output;
		// Actual entry size, excluding tar padding.
		const data = request.kind === 'archive' ? payload.subarray(0, Number.parseInt(new TextDecoder().decode(output.subarray(124, 136)).replace(/\0/g, '').trim(), 8)) : payload;
		const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))).map(x => x.toString(16).padStart(2, '0')).join('');
		self.postMessage({ totalMs, requestCount, peakDiskBytes, networkMs, cpuMs: globalThis.benchmarkCpuMs, writeMs, outputBytes, hash });
	} catch (error) {
		self.postMessage({ error: error instanceof Error ? error.message : String(error) });
	} finally { pipeline?.close(); }
};
