import { afterEach, describe, expect, test, vi } from 'vitest';
import { createBgzfBlock, BgzfBlockDecoder, createBgzfDecompressor } from '../../bgzf/src';
import { DownloadScheduler } from '../src/client/store/download-scheduler';
import { DownloadPipeline, parallelBgzf, parallelDecrypt } from '../src/client/workers/download-pipeline';
import { processDownloadJob, type ProcessingJob } from '../src/client/workers/download-processing';
import { AdaptiveDownloadConcurrency } from '../src/client/workers/download-adaptive';
import { encryptBlob, importAesCtrKey, decryptAesCtrRange } from '../src/shared/encryption';
import { createRangedDownloadStream } from '../src/client/workers/download-resilience';

const schedulers: DownloadScheduler[] = [];
const pipelines: DownloadPipeline[] = [];
afterEach(() => { for (const p of pipelines.splice(0)) p.close(); vi.unstubAllGlobals(); });

function setup(limit = 3, fail = false) {
	let active = 0;
	let peak = 0;
	const scheduler = new DownloadScheduler(limit, 8, () => {
		const worker = {
			onmessage: null as ((event: unknown) => void) | null,
			onerror: null as (() => void) | null,
			terminate() {},
			postMessage(message: { jobId: number; job: ProcessingJob }) {
				const input = structuredClone(message, { transfer: [message.job.bytes.buffer] });
				active++; peak = Math.max(active, peak);
				void new Promise(resolve => setTimeout(resolve, input.job.position === 0 ? 15 : 1)).then(async () => {
					try {
						if (fail) { worker.onerror?.(); return; }
						const result = await processDownloadJob(input.job);
						result.durationMs = 100; // deterministic CPU seed, independent of machine speed
						active--;
						worker.onmessage?.({ data: { jobId: input.jobId, result } });
					} finally { if (fail) active--; }
				});
			},
		};
		return worker as unknown as Worker;
	});
	schedulers.push(scheduler);
	const pipeline = new DownloadPipeline(scheduler.connect(`test-${schedulers.length}`));
	pipelines.push(pipeline);
	return { scheduler, pipeline, peak: () => peak };
}

function stream(bytes: Uint8Array<ArrayBuffer>, chunkSize = 65531) {
	let offset = 0;
	return new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(c) {
		if (offset >= bytes.length) { c.close(); return; }
		c.enqueue(bytes.subarray(offset, offset + chunkSize)); offset += chunkSize;
	} }, { highWaterMark: 0 });
}

async function collect(source: ReadableStream<Uint8Array<ArrayBuffer>>) {
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	for await (const chunk of source) chunks.push(chunk);
	return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

async function seed(pipeline: DownloadPipeline) { const release = await pipeline.network(); release(4 * 1024 * 1024, 1); }

for (const limit of [1, 3]) {
	test(`parallel AES-CTR and BGZF preserve bytes at limit ${limit}`, async () => {
		const { pipeline, scheduler, peak } = setup(limit);
		await pipeline.start(); await seed(pipeline);
		const raw = new Uint8Array(5 * 1024 * 1024 + 13);
		for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + (i >>> 8)) & 255;
		const key = await importAesCtrKey(new Uint8Array(32));
		const encrypted = new Uint8Array(await (await encryptBlob(new Blob([raw]), key, new Uint8Array(16))).arrayBuffer());
		expect(Buffer.compare(await collect(parallelDecrypt(stream(encrypted, 7 * 65536 + 3), key, pipeline, true)), raw)).toBe(0);
		const compressed: Uint8Array<ArrayBuffer>[] = [];
		for (let offset = 0; offset < raw.length; offset += 32000) compressed.push(await createBgzfBlock(raw.subarray(offset, offset + 32000)));
		const bgzf = new Uint8Array(await new Blob(compressed).arrayBuffer());
		expect(Buffer.compare(await collect(parallelBgzf(stream(bgzf, 17), pipeline, true)), raw)).toBe(0);
		expect(scheduler.snapshot().peakCpu).toBe(limit);
		expect(peak()).toBeLessThanOrEqual(limit);
	});
}

test('unaligned CTR range, carry across 128-bit counter bytes and empty plaintext', async () => {
	const key = await importAesCtrKey(new Uint8Array(32));
	const iv = new Uint8Array(16).fill(255); iv[0] = 1;
	const raw = new Uint8Array(513).map((_, i) => i);
	const encrypted = new Uint8Array(await (await encryptBlob(new Blob([raw]), key, iv)).arrayBuffer());
	for (const offset of [0, 1, 15, 16, 17, 255]) expect(await decryptAesCtrRange(key, iv, encrypted.subarray(16 + offset, 16 + offset + 33), offset)).toEqual(raw.subarray(offset, offset + 33));
	const { pipeline } = setup(); await pipeline.start();
	expect(await collect(parallelDecrypt(stream(iv, 1), key, pipeline))).toHaveLength(0);
	await expect(collect(parallelDecrypt(stream(iv.subarray(0, 15)), key, pipeline))).rejects.toThrow(/IV/);
});

test('BGZF rejects CRC corruption, truncated blocks and invalid sizes, accepts EOF marker', async () => {
	const block = await createBgzfBlock(new Uint8Array([1, 2, 3]));
	const corrupted = block.slice(); corrupted[corrupted.length - 8] ^= 1;
	await expect(collect(stream(corrupted).pipeThrough(createBgzfDecompressor()))).rejects.toThrow();
	await expect(collect(stream(block.subarray(0, block.length - 1)).pipeThrough(createBgzfDecompressor()))).rejects.toThrow(/Truncated/);
	const invalid = block.slice(); invalid[16] = 0; invalid[17] = 0;
	expect(() => [...new BgzfBlockDecoder().push(invalid)]).toThrow(/size/);
	const eof = await createBgzfBlock(new Uint8Array());
	expect(await collect(stream(eof, 1).pipeThrough(createBgzfDecompressor()))).toHaveLength(0);
});

test('shared admission reserves downstream capacity and frees a lane on cancellation', async () => {
	const { scheduler, pipeline } = setup();
	const second = new DownloadPipeline(scheduler.connect('second'));
	const third = new DownloadPipeline(scheduler.connect('third'));
	pipelines.push(second, third);
	await pipeline.start(); await second.start();
	let admitted = false;
	const waiting = third.start().then(() => { admitted = true; });
	await new Promise(resolve => setTimeout(resolve, 10));
	expect(admitted).toBe(false);
	expect(scheduler.snapshot().networkReservedBytes).toBe(64 * 1024 * 1024);
	pipeline.close(); await waiting;
	expect(scheduler.snapshot().processingReservedBytes).toBe(64 * 1024 * 1024);
	second.close(); third.close();
	await vi.waitFor(() => expect(scheduler.snapshot().sessions).toBe(0));
	expect(scheduler.snapshot().networkReservedBytes).toBe(0);
});

test('processing worker failure aborts its stream and releases reservations', async () => {
	const { pipeline, scheduler } = setup(3, true);
	await pipeline.start();
	const key = await importAesCtrKey(new Uint8Array(32));
	await expect(collect(parallelDecrypt(stream(new Uint8Array(100)), key, pipeline))).rejects.toThrow(/worker failed/);
	await vi.waitFor(() => expect(scheduler.snapshot().sessions).toBe(0));
});

describe('adaptive controller', () => {
	test('seeds from comparable input, trials one stage, rolls back and respects cooldown and hardware', () => {
		const a = new AdaptiveDownloadConcurrency(8, 4);
		a.sample('network', 1000, 10, 10, { cpu: false, network: true });
		a.sample('cpu', 1000, 30, 20, { cpu: false, network: true }, 'decrypt', true);
		expect(a.cpu).toBe(3);
		a.sample('network', 1000, 10, 1000, { cpu: false, network: true });
		a.sample('network', 1000, 10, 2100, { cpu: false, network: true });
		expect(a.network).toBe(1);
		for (const now of [1000, 2100]) a.sample('cpu', 1000, 30, now, { cpu: true }, 'decrypt', true);
		expect(a.cpu).toBe(4);
		for (const now of [2800, 3500, 4200]) a.sample('cpu', 1000, 30, now, { cpu: true }, 'decrypt', true);
		expect(a.cpu).toBe(3);
		expect(a.network).toBe(1);
		for (const now of [4900, 5600, 6300]) a.sample('cpu', 1000, 30, now, { cpu: true }, 'decrypt', true);
		expect(a.cpu).toBe(3);
		expect(a.network).toBe(1);
		a.limit = 1; a.clamp(); expect(a.cpu).toBe(1);
	});
});

test('serial ranges wait for delayed input and bound queued ranges', async () => {
	const requests: number[] = [];
	let unblock!: () => void;
	vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
		const start = Number(new Headers(init.headers).get('Range')!.match(/bytes=(\d+)/)![1]);
		requests.push(start);
		if (start === 4) await new Promise<void>(resolve => { unblock = resolve; });
		return new Response(new Uint8Array([start, start + 1, start + 2, start + 3]), { status: 206, headers: { 'Content-Range': `bytes ${start}-${start + 3}/32`, ETag: '"v1"' } });
	}));
	const reader = createRangedDownloadStream('/file', {}, { rangeSize: 4, maxBufferedRanges: 4, maxAttempts: 1, requestTimeoutMs: 1000, inactivityTimeoutMs: 1000 }).getReader();
	expect((await reader.read()).value).toEqual(new Uint8Array([0, 1, 2, 3]));
	const head = reader.read();
	await vi.waitFor(() => expect(requests).toEqual([0, 4]));
	await new Promise(resolve => setTimeout(resolve, 10));
	expect(requests).toHaveLength(2);
	unblock(); expect((await head).value).toEqual(new Uint8Array([4, 5, 6, 7]));
	await vi.waitFor(() => expect(requests).toHaveLength(6));
	await new Promise(resolve => setTimeout(resolve, 10));
	expect(requests).toHaveLength(6);
	const rest: number[] = [];
	while (true) { const { done, value } = await reader.read(); if (done) break; rest.push(...value); }
	expect(rest).toEqual(Array.from({ length: 24 }, (_, i) => i + 8));
});

test('rejects changed validators even when server returns 206', async () => {
	let call = 0;
	vi.stubGlobal('fetch', vi.fn(async () => {
		const start = call++ * 4;
		return new Response(new Uint8Array(4), { status: 206, headers: { 'Content-Range': `bytes ${start}-${start + 3}/8`, ETag: start ? '"v2"' : '"v1"' } });
	}));
	await expect(collect(createRangedDownloadStream('/file', {}, { rangeSize: 4, maxBufferedRanges: 4, maxAttempts: 1, requestTimeoutMs: 1000, inactivityTimeoutMs: 1000 }))).rejects.toThrow(/representation changed/);
});

test('slow sink stops read-ahead and cancellation frees queued work', async () => {
	const { pipeline, scheduler } = setup();
	await pipeline.start();
	const key = await importAesCtrKey(new Uint8Array(32));
	let produced = 0;
	const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(c) {
		produced += 4 * 1024 * 1024;
		c.enqueue(new Uint8Array(4 * 1024 * 1024));
	} }, { highWaterMark: 0 });
	const reader = parallelDecrypt(source, key, pipeline).getReader();
	expect((await reader.read()).value?.length).toBe(1024 * 1024);
	const stalledAt = produced;
	await new Promise(resolve => setTimeout(resolve, 30));
	expect(produced).toBe(stalledAt);
	expect(produced).toBeLessThanOrEqual(8 * 1024 * 1024);
	await reader.cancel(new Error('stop saving'));
	await vi.waitFor(() => expect(scheduler.snapshot().sessions).toBe(0));
	expect(scheduler.snapshot().activeCpu).toBe(0);
});

test('parallel tar decryption preserves empty and unaligned entries and their order', async () => {
	const { createTarHeader, parseTarStream } = await import('../../bgzf/src');
	const { createDecryptedTarStream } = await import('../src/client/workers/decrypted-tar');
	const { pipeline } = setup(); await pipeline.start(); await seed(pipeline);
	const key = await importAesCtrKey(new Uint8Array(32));
	const originals = [new Uint8Array(), new Uint8Array(31).fill(7), new Uint8Array(5 * 1024 * 1024 + 17).fill(9)];
	const parts: BlobPart[] = [];
	for (const [i, original] of originals.entries()) {
		const encrypted = await encryptBlob(new Blob([original]), key, new Uint8Array(16).fill(i));
		parts.push(createTarHeader(`${i}.bin`, encrypted.size, 0), encrypted, new Uint8Array((512 - encrypted.size % 512) % 512));
	}
	parts.push(new Uint8Array(1024));
	const input = new Uint8Array(await new Blob(parts).arrayBuffer());
	const now = vi.spyOn(Date, 'now').mockReturnValue(1234567890000);
	try {
		const parallel = await collect(createDecryptedTarStream(stream(input), key, () => {}, () => {}, (source, key) => parallelDecrypt(source, key, pipeline)));
		const serial = await collect(createDecryptedTarStream(stream(input), key, () => {}, () => {}));
		expect(Buffer.compare(parallel, serial)).toBe(0);
		let i = 0;
		for await (const entry of parseTarStream(stream(parallel))) {
			expect(entry.name).toBe(`${i}.bin`);
			expect(Buffer.compare(await collect(entry.stream), originals[i++])).toBe(0);
		}
		expect(i).toBe(3);
	} finally { now.mockRestore(); }
});

test('empty ranged response closes without a processing job', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */0' } })));
	expect(await collect(createRangedDownloadStream('/empty', {}, { rangeSize: 4, maxAttempts: 1, requestTimeoutMs: 1000, inactivityTimeoutMs: 1000 }))).toHaveLength(0);
});

test('network leases are serial across downloads and release independently of CPU work', async () => {
	const { scheduler, pipeline } = setup();
	const second = new DownloadPipeline(scheduler.connect('network-second')); pipelines.push(second);
	await Promise.all([pipeline.start(), second.start()]);
	const firstRelease = await pipeline.network();
	let secondStarted = false;
	const waiting = second.network().then(release => { secondStarted = true; return release; });
	await new Promise(resolve => setTimeout(resolve, 10));
	expect(secondStarted).toBe(false);
	firstRelease(32 * 1024 * 1024, 100);
	const secondRelease = await waiting;
	expect(scheduler.snapshot().activeNetwork).toBe(1);
	expect(scheduler.snapshot().peakNetwork).toBe(1);
	secondRelease(32 * 1024 * 1024, 100);
	await Promise.all([pipeline.finish(), second.finish()]);
	await vi.waitFor(() => expect(scheduler.snapshot().sessions).toBe(0));
});

test('storage failure stops without retrying GET and closes the cache', async () => {
	const close = vi.fn(async () => {});
	const abort = vi.fn(async () => {});
	const fetch = vi.fn(async () => new Response(new Uint8Array(4), { status: 206, headers: { 'Content-Range': 'bytes 0-3/4', ETag: '"v1"' } }));
	vi.stubGlobal('fetch', fetch);
	let cleanup!: Promise<void>;
	const source = createRangedDownloadStream('/quota', {}, { rangeSize: 4, maxAttempts: 3, requestTimeoutMs: 1000, inactivityTimeoutMs: 1000, onCleanup: promise => { cleanup = promise; }, cacheFactory: async () => ({ disk: true, close, create: async () => ({ write: async () => { throw new DOMException('full', 'QuotaExceededError'); }, abort, finish: async () => { throw new Error('unreachable'); } }) }) });
	await expect(collect(source)).rejects.toThrow(/storage failed/);
	await cleanup;
	expect(fetch).toHaveBeenCalledTimes(1); expect(abort).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});

test('admission stays reserved until range cleanup completes', async () => {
	const { scheduler, pipeline } = setup(); await pipeline.start();
	let release!: () => void;
	pipeline.trackCleanup(new Promise<void>(resolve => { release = resolve; }));
	pipeline.close();
	await new Promise(resolve => setTimeout(resolve, 10));
	expect(scheduler.snapshot().activeDownloads).toBe(1);
	release(); await pipeline.finish();
	await vi.waitFor(() => expect(scheduler.snapshot().activeDownloads).toBe(0));
});

test('processing worker failure retains the network lease until cleanup acknowledges abort', async () => {
	const { pipeline, scheduler } = setup(3, true); await pipeline.start();
	await pipeline.network();
	let release!: () => void;
	pipeline.trackCleanup(new Promise<void>(resolve => { release = resolve; }));
	const key = await importAesCtrKey(new Uint8Array(32));
	await expect(pipeline.process({ kind: 'decrypt', bytes: new Uint8Array(16), outputBytes: 16, key, iv: new Uint8Array(16), position: 0 })).rejects.toThrow(/worker failed/);
	expect(scheduler.snapshot().activeNetwork).toBe(1);
	expect(scheduler.snapshot().activeDownloads).toBe(1);
	release(); await pipeline.finish();
	await vi.waitFor(() => expect(scheduler.snapshot().sessions).toBe(0));
});
