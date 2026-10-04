import { afterEach, expect, test, vi } from 'vitest';
import { createBgzfBlock } from '../../bgzf/src';
import { createArchiveEntryDownloadStream, trimEntryStream } from '../src/client/workers/archive-entry-download';
import { createRangedDownloadStream } from '../src/client/workers/download-resilience';
import { DownloadPipeline } from '../src/client/workers/download-pipeline';
import { DownloadScheduler } from '../src/client/store/download-scheduler';
import { processDownloadJob, DOWNLOAD_RANGE_BYTES, type ProcessingJob } from '../src/client/workers/download-processing';
import { encryptBlob, decryptBlob, importAesCtrKey, keyToMultibase } from '../src/shared/encryption';

const pipelines: DownloadPipeline[] = [];
afterEach(async () => { await Promise.all(pipelines.splice(0).map(p => p.finish())); vi.unstubAllGlobals(); });

async function pipeline() {
	const scheduler = new DownloadScheduler(2, 2, () => {
		const worker = {
			onmessage: null as ((event: unknown) => void) | null,
			terminate() {},
			postMessage(message: { jobId: number; job: ProcessingJob }) {
				const input = structuredClone(message, { transfer: [message.job.bytes.buffer] });
				void processDownloadJob(input.job).then(result => worker.onmessage?.({ data: { jobId: input.jobId, result } }));
			},
		};
		return worker as unknown as Worker;
	});
	const p = new DownloadPipeline(scheduler.connect('entry'));
	pipelines.push(p); await p.start(); return p;
}

const options = { rangeSize: DOWNLOAD_RANGE_BYTES, readChunkSize: 1024 * 1024, maxAttempts: 1, requestTimeoutMs: 5000, inactivityTimeoutMs: 5000 };

async function collect(stream: ReadableStream<Uint8Array<ArrayBuffer>>) {
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

function serve(bytes: Uint8Array<ArrayBuffer>) {
	vi.stubGlobal('location', { origin: 'https://example.test' });
	const requests: Array<{ url: string; range: string; auth: string | null }> = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
		const headers = new Headers(init.headers);
		const range = headers.get('Range')!;
		requests.push({ url, range, auth: headers.get('Authorization') });
		const [start, wantedEnd] = range.slice(6).split('-').map(Number);
		const end = Math.min(wantedEnd, bytes.length - 1);
		return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ETag: '"fixture"' } });
	}));
	return requests;
}

test('encrypted indexed tar crosses 32 MiB, IV and AES boundaries with entry-relative CTR and bounded demand', async () => {
	const rawKey = new Uint8Array(32).fill(7);
	const key = await importAesCtrKey(rawKey);
	const original = new Uint8Array(DOWNLOAD_RANGE_BYTES + 37);
	for (let i = 0; i < original.length; i++) original[i] = (i * 73 + (i >>> 13)) & 255;
	const encrypted = await encryptBlob(new Blob([original]), key, new Uint8Array(16).fill(3));
	const offset = 733;
	const archive = new Uint8Array(offset + encrypted.size + 99);
	archive.set(new Uint8Array(await encrypted.arrayBuffer()), offset);
	const requests = serve(archive);
	let peak = 0;
	const p = await pipeline();
	const output = await createArchiveEntryDownloadStream('/d/test?token=fixture', { headers: { Authorization: 'Bearer fixture' }, signal: p.abort.signal }, { type: 'tar', path: 'dir/file.bin', offset, size: encrypted.size }, p, { ...options, onQueue(bytes) { peak = Math.max(peak, bytes); } }, keyToMultibase(rawKey));
	const reader = output.getReader();
	const chunks = [(await reader.read()).value!];
	await new Promise(resolve => setTimeout(resolve, 20));
	expect(requests).toHaveLength(1);
	while (true) { const result = await reader.read(); if (result.done) break; chunks.push(result.value); }
	const actual = new Uint8Array(await new Blob(chunks).arrayBuffer());
	expect(Buffer.compare(actual, original)).toBe(0);
	expect(Buffer.compare(actual, new Uint8Array(await (await decryptBlob(encrypted, key)).arrayBuffer()))).toBe(0);
	expect(requests.map(r => r.range)).toEqual([`bytes=${offset}-${offset + DOWNLOAD_RANGE_BYTES - 1}`, `bytes=${offset + DOWNLOAD_RANGE_BYTES}-${offset + encrypted.size - 1}`]);
	expect(new URL(requests[0].url).searchParams.get('entry')).toBe('dir/file.bin');
	expect(requests[1].url).not.toContain('entry=');
	expect(requests.every(r => r.auth === 'Bearer fixture')).toBe(true);
	expect(peak).toBe(DOWNLOAD_RANGE_BYTES);
}, 30000);

test.each([0, 1, 15, 16, 17, 31, 65537])('BGZF encrypted entry length %i survives split blocks and suffix trims', async length => {
	const rawKey = new Uint8Array(32).fill(9);
	const key = await importAesCtrKey(rawKey);
	const original = new Uint8Array(length).fill(51);
	const encrypted = new Uint8Array(await (await encryptBlob(new Blob([original]), key, new Uint8Array(16).fill(2))).arrayBuffer());
	const prefix = 511, suffix = 77;
	const decompressed = new Uint8Array(prefix + encrypted.length + suffix);
	decompressed.set(encrypted, prefix);
	const blocks: Uint8Array<ArrayBuffer>[] = [];
	for (let i = 0; i < decompressed.length; i += 16384) blocks.push(await createBgzfBlock(decompressed.slice(i, i + 16384)));
	const compressed = new Uint8Array(await new Blob(blocks).arrayBuffer());
	const archive = new Uint8Array(compressed.length + 48); archive.set(compressed, 19);
	const requests = serve(archive);
	const p = await pipeline();
	const output = await createArchiveEntryDownloadStream('/d/test', { signal: p.abort.signal }, { type: 'targz', path: 'file.bin', aStart: 19, aEnd: 19 + compressed.length, rStartOffset: prefix, rEndOffset: suffix }, p, { ...options, rangeSize: 37, readChunkSize: 37 }, keyToMultibase(rawKey));
	expect(Buffer.compare(await collect(output), original)).toBe(0);
	expect(requests.length).toBeGreaterThan(1);
});

test('ordinary gzip indexed streaming reports unsupported instead of decrypting archive bytes', async () => {
	const gzip = new Uint8Array(await new Response(new Blob(['ordinary']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
	serve(gzip); const p = await pipeline();
	const output = await createArchiveEntryDownloadStream('/d/test', {}, { type: 'targz', path: 'file', aStart: 0, aEnd: gzip.length, rStartOffset: 0, rEndOffset: 0 }, p, options);
	await expect(collect(output)).rejects.toThrow(/requires BGZF/);
});

test('bounded empty span does not fetch and malformed bounds are rejected', async () => {
	const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
	expect(await collect(createRangedDownloadStream('/d/test', {}, { ...options, start: 512, end: 512 }))).toHaveLength(0);
	expect(fetch).not.toHaveBeenCalled();
	for (const start of [-1, 0.5, NaN, Infinity]) expect(() => createRangedDownloadStream('/d/test', {}, { ...options, start })).toThrow(/bounds/);
	expect(() => createRangedDownloadStream('/d/test', {}, { ...options, start: 5, end: 4 })).toThrow(/bounds/);
});

test('demand-driven ranges never request the next span after cancellation', async () => {
	const requests = serve(new Uint8Array(100));
	const reader = createRangedDownloadStream('/d/test', {}, { ...options, start: 7, end: 97, rangeSize: 30, readChunkSize: 30, demandDriven: true }).getReader();
	await reader.read(); await new Promise(resolve => setTimeout(resolve, 20));
	expect(requests).toHaveLength(1);
	await reader.cancel(); await new Promise(resolve => setTimeout(resolve, 20));
	expect(requests).toHaveLength(1);
});

test('prefix and suffix trim rejects truncated entry spans', async () => {
	const source = new Blob([new Uint8Array(20)]).stream();
	await expect(collect(trimEntryStream(source, 21, 0))).rejects.toThrow(/Truncated/);
});

test('random bounded spans, including short EOF ranges, match archive bytes', async () => {
	const bytes = new Uint8Array(65537); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
	serve(bytes);
	let random = 12345;
	for (let i = 0; i < 25; i++) {
		random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
		const start = random % bytes.length;
		const end = i === 0 ? bytes.length : start + (random % (bytes.length - start));
		const actual = await collect(createRangedDownloadStream('/d/test', {}, { ...options, start, end, rangeSize: 1007, demandDriven: true }));
		expect(Buffer.compare(actual, bytes.slice(start, end))).toBe(0);
	}
});

test.each(['bytes 6-9/20', 'bytes 5-8/20', 'bytes 5-9/9', 'bytes 5-9/*'])('rejects invalid Content-Range %s', async range => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(5), { status: 206, headers: { 'Content-Range': range } })));
	await expect(collect(createRangedDownloadStream('/d/test', {}, { ...options, start: 5, end: 10 }))).rejects.toThrow(/Content-Range/);
});

test('rejects unexpected 200 before reading and detects oversized bounds/body/Content-Length', async () => {
	let reads = 0, cancelled = false;
	vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status: 200 })));
	await expect(collect(createRangedDownloadStream('/d/test', {}, { ...options, start: 5, end: 10 }))).rejects.toThrow(/206/);
	expect(reads).toBe(0); expect(cancelled).toBe(true);
	serve(new Uint8Array(9));
	await expect(collect(createRangedDownloadStream('/d/test', {}, { ...options, start: 5, end: 10 }))).rejects.toThrow(/bounds exceed/);
	vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(6), { status: 206, headers: { 'Content-Range': 'bytes 5-9/20' } })));
	await expect(collect(createRangedDownloadStream('/d/test', {}, { ...options, start: 5, end: 10 }))).rejects.toThrow(/exceeded/);
	vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(5), { status: 206, headers: { 'Content-Range': 'bytes 5-9/20', 'Content-Length': '4' } })));
	await expect(collect(createRangedDownloadStream('/d/test', {}, { ...options, start: 5, end: 10 }))).rejects.toThrow(/Content-Length/);
});

test('encrypted BGZF entry crosses the 32 MiB compressed transport boundary', async () => {
	const rawKey = new Uint8Array(32).fill(12);
	const key = await importAesCtrKey(rawKey);
	const original = new Uint8Array(DOWNLOAD_RANGE_BYTES + 257).fill(27);
	const encrypted = new Uint8Array(await (await encryptBlob(new Blob([original]), key, new Uint8Array(16).fill(5))).arrayBuffer());
	const prefix = 723, suffix = 51;
	const plain = new Uint8Array(prefix + encrypted.length + suffix); plain.set(encrypted, prefix);
	const blocks: Uint8Array<ArrayBuffer>[] = [];
	for (let i = 0; i < plain.length; i += 32768) blocks.push(await createBgzfBlock(plain.slice(i, i + 32768)));
	const compressed = new Uint8Array(await new Blob(blocks).arrayBuffer());
	expect(compressed.length).toBeGreaterThan(DOWNLOAD_RANGE_BYTES);
	const archive = new Uint8Array(compressed.length + 91); archive.set(compressed, 19);
	const requests = serve(archive);
	const p = await pipeline();
	const output = await createArchiveEntryDownloadStream('/d/test', { signal: p.abort.signal }, { type: 'targz', path: 'entry.bin', aStart: 19, aEnd: 19 + compressed.length, rStartOffset: prefix, rEndOffset: suffix }, p, options, keyToMultibase(rawKey));
	let length = 0;
	for await (const bytes of output) {
		expect(bytes.every(byte => byte === 27)).toBe(true); length += bytes.length;
	}
	expect(length).toBe(original.length);
	expect(requests).toHaveLength(2);
	expect(requests[0].range).toBe(`bytes=19-${19 + DOWNLOAD_RANGE_BYTES - 1}`);
	expect(requests[1].range).toBe(`bytes=${19 + DOWNLOAD_RANGE_BYTES}-${19 + compressed.length - 1}`);
}, 30000);
