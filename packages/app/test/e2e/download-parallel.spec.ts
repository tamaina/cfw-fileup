import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { createBgzfBlock, createTarHeader } from '../../../bgzf/src';
import { encryptBlob, importAesCtrKey, keyToMultibase } from '../../src/shared/encryption';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const rawKey = new Uint8Array(32).fill(9);
const keyString = keyToMultibase(rawKey);
let raw: Buffer<ArrayBuffer>;
let encrypted: Buffer;
let bgzf: Buffer;
let archive: Buffer;
test.beforeAll(async () => {
	raw = Buffer.alloc(9 * 1024 * 1024 + 19);
	let state = 123456;
	for (let i = 0; i < raw.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; raw[i] = state & 255; }
	const key = await importAesCtrKey(rawKey);
	encrypted = Buffer.from(await (await encryptBlob(new Blob([raw]), key, new Uint8Array(16))).arrayBuffer());
	const compress = async (input: Buffer<ArrayBuffer>) => {
		const blocks = [];
		for (let offset = 0; offset < input.length; offset += 64000) blocks.push(await createBgzfBlock(input.subarray(offset, offset + 64000)));
		return Buffer.concat(blocks);
	};
	bgzf = await compress(raw);
	archive = await compress(Buffer.concat([createTarHeader('large.bin', encrypted.length, 0), encrypted, Buffer.alloc((512 - encrypted.length % 512) % 512), Buffer.alloc(1024)]));
});

for (const limit of [1, 3]) {
	for (const kind of ['encrypted', 'bgzf', 'archive'] as const) {
		test(`parallel download ${kind}, limit ${limit}`, async ({ page, context }) => {
			const input = kind === 'encrypted' ? encrypted : kind === 'bgzf' ? bgzf : archive;
			await context.route('**/d/parallel-fixture', async route => {
				const match = route.request().headers().range.match(/bytes=(\d+)-(\d+)/)!;
				const start = Number(match[1]);
				const end = Math.min(Number(match[2]), input.length - 1);
				await route.fulfill({ status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${input.length}`, ETag: '"parallel-fixture"' }, body: input.subarray(start, end + 1) });
			});
			await page.goto('/my/downloads');
			await page.locator('#download-concurrency').fill(String(limit));
			await page.getByRole('button', { name: '保存', exact: true }).click();
			const result = await page.evaluate(async ({ kind, keyString }) => {
				const workerPath = '/src/client/store/download-worker.ts';
				const { runDownloadTransform, runArchiveDownload, getDownloadDiagnostics } = await import(/* @vite-ignore */ workerPath);

				const chunks: Uint8Array<ArrayBuffer>[] = [];
				let finishSink!: () => void;
				const sinkDone = new Promise<void>(resolve => { finishSink = resolve; });
				const writable = new WritableStream<Uint8Array>({ write(chunk) { chunks.push(new Uint8Array(chunk)); }, close() { finishSink(); } });
				if (kind === 'archive') await runArchiveDownload({ mode: 'archive-decrypt', fileId: 'parallel-fixture', isTargz: true, decompress: true, filename: 'output.tar', encryptionKey: keyString, authHeaders: {}, writable }).promise;
				else await runDownloadTransform({ mode: 'download', url: '/d/parallel-fixture', filename: 'output.bin', mimeType: 'application/octet-stream', transform: kind === 'bgzf' ? 'decompress-gzip' : 'none', encryptionKey: kind === 'encrypted' ? keyString : undefined, authHeaders: {}, writable }).promise;
				await sinkDone;
				const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
				const payload = kind === 'archive' ? bytes.subarray(512, 512 + Number.parseInt(new TextDecoder().decode(bytes.subarray(124, 136)).replace(/\0/g, '').trim(), 8)) : bytes;
				const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', payload))).map(x => x.toString(16).padStart(2, '0')).join('');
				return { hash, size: payload.length, snapshot: getDownloadDiagnostics(), prefix: Array.from(payload.subarray(0, 24)) };
			}, { kind, keyString });
			expect(result.hash, JSON.stringify({ ...result, inputHash: digest(input), inputSize: input.length })).toBe(digest(raw));
			expect(result.size).toBe(raw.length);
			expect(result.snapshot.peakCpu).toBeGreaterThanOrEqual(1);
			expect(result.snapshot.peakCpu).toBeLessThanOrEqual(limit);
			expect(result.snapshot.networkReservedBytes).toBe(0);
			expect(result.snapshot.processingReservedBytes).toBe(0);
		});
	}
}

test('download setting rejects invalid input and survives reload', async ({ page }) => {
	await page.goto('/my/downloads');
	const input = page.locator('#download-concurrency');
	await expect(input).toHaveValue('3');
	await input.fill('0');
	await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
	await input.fill('8');
	await page.getByRole('button', { name: '保存', exact: true }).click();
	await page.reload();
	await expect(input).toHaveValue('8');
	await page.screenshot({ path: '/tmp/cfw-download-settings.png', fullPage: true });
});

test('real processing workers share the tab limit across two downloads', async ({ page }) => {
	await page.goto('/');
	const result = await page.evaluate(async () => {
		const schedulerPath = '/src/client/store/download-scheduler.ts';
		const pipelinePath = '/src/client/workers/download-pipeline.ts';
		const { DownloadScheduler } = await import(/* @vite-ignore */ schedulerPath);
		const { DownloadPipeline } = await import(/* @vite-ignore */ pipelinePath);
		const broker = new DownloadScheduler(3, 8);
		const a = new DownloadPipeline(broker.connect('a'));
		const b = new DownloadPipeline(broker.connect('b'));
		await Promise.all([a.start(), b.start()]);
		const key = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'AES-CTR' }, false, ['decrypt']);
		const release = await a.network(); release(4 * 1024 * 1024, 0.01);
		await a.process({ kind: 'decrypt', bytes: new Uint8Array(1024 * 1024), outputBytes: 1024 * 1024, key, iv: new Uint8Array(16), position: 0, comparable: true });
		const outputs = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).process({ kind: 'decrypt', bytes: new Uint8Array(1024 * 1024), outputBytes: 1024 * 1024, key, iv: new Uint8Array(16), position: 0 })));
		const equal = outputs.every(x => x.every((v: number, i: number) => v === outputs[0][i]));
		const snapshot = broker.snapshot();
		broker.setLimit(1);
		await a.process({ kind: 'decrypt', bytes: new Uint8Array(1), outputBytes: 1, key, iv: new Uint8Array(16), position: 0 });
		const reduced = broker.snapshot();
		broker.close('a'); broker.close('b'); a.close(); b.close();
		return { equal, snapshot, reduced, closed: broker.snapshot() };
	});
	expect(result.equal).toBe(true);
	expect(result.snapshot.peakCpu).toBe(3);
	expect(result.snapshot.activeDownloads).toBe(2);
	expect(result.reduced.cpuTarget).toBe(1);
	expect(result.closed.processingReservedBytes).toBe(0);
});

test('a failed destination cancels one download while another completes', async ({ page, context }) => {
	await context.route('**/d/parallel-fixture', async route => {
		const match = route.request().headers().range.match(/bytes=(\d+)-(\d+)/)!;
		const start = Number(match[1]); const end = Math.min(Number(match[2]), encrypted.length - 1);
		await route.fulfill({ status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}`, ETag: '"parallel-fixture"' }, body: encrypted.subarray(start, end + 1) });
	});
	await page.goto('/');
	const result = await page.evaluate(async keyString => {
		const workerPath = '/src/client/store/download-worker.ts';
		const { runDownloadTransform, getDownloadDiagnostics } = await import(/* @vite-ignore */ workerPath);
		const request = { mode: 'download', url: '/d/parallel-fixture', filename: 'output.bin', mimeType: 'application/octet-stream', transform: 'none', encryptionKey: keyString, authHeaders: {} };
		let received = 0;
		let close!: () => void;
		const closed = new Promise<void>(resolve => { close = resolve; });
		const first = runDownloadTransform({ ...request, writable: new WritableStream({ write() { throw new Error('destination failed'); } }) }).promise;
		const second = runDownloadTransform({ ...request, writable: new WritableStream<Uint8Array>({ write(value) { received += value.length; }, close }) }).promise;
		const results = await Promise.allSettled([first, second]);
		await closed;
		return { statuses: results.map(r => r.status), received, snapshot: getDownloadDiagnostics() };
	}, keyString);
	expect(result.statuses).toEqual(['rejected', 'fulfilled']);
	expect(result.received).toBe(raw.length);
	expect(result.snapshot.sessions).toBe(0);
});

for (const direct of [false, true]) {
	test(`file handle save, direct=${direct}`, async ({ page, context, browserName }) => {
		test.skip(direct && browserName !== 'chromium', 'Picker-facing File System Access path is Chromium-only.');
		await context.route('**/d/parallel-fixture', async route => {
			const match = route.request().headers().range.match(/bytes=(\d+)-(\d+)/)!;
			const start = Number(match[1]); const end = Math.min(Number(match[2]), encrypted.length - 1);
			await route.fulfill({ status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}`, ETag: '"parallel-fixture"' }, body: encrypted.subarray(start, end + 1) });
		});
		await page.goto('/');
		const result = await page.evaluate(async ({ direct, keyString }) => {
			const path = '/src/client/store/download-worker.ts';
			const { runDownloadTransform } = await import(/* @vite-ignore */ path);
			const directory = await navigator.storage.getDirectory();
			const fileHandle = direct ? await directory.getFileHandle('parallel-direct-test.bin', { create: true }) : undefined;
			const result = await runDownloadTransform({ mode: 'download', url: '/d/parallel-fixture', filename: 'output.bin', mimeType: 'application/octet-stream', transform: 'none', encryptionKey: keyString, authHeaders: {}, fileHandle }).promise;
			const name = fileHandle?.name ?? result.opfsName;
			const saved = await (await directory.getFileHandle(name)).getFile();
			const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await saved.arrayBuffer()))).map(x => x.toString(16).padStart(2, '0')).join('');
			await directory.removeEntry(name);
			return { hash, direct: result.savedDirectly };
		}, { direct, keyString });
		expect(result.hash).toBe(digest(raw));
		expect(result.direct).toBe(direct);
	});
}

for (const format of ['gzip', 'zip'] as const) {
	test(`encrypted archive saved as ${format}`, async ({ page, context }) => {
		await context.route('**/d/parallel-fixture', async route => {
			const match = route.request().headers().range.match(/bytes=(\d+)-(\d+)/)!;
			const start = Number(match[1]); const end = Math.min(Number(match[2]), archive.length - 1);
			await route.fulfill({ status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${archive.length}`, ETag: '"parallel-fixture"' }, body: archive.subarray(start, end + 1) });
		});
		await page.goto('/');
		const downloadPromise = page.waitForEvent('download');
		const completion = page.evaluate(async ({ format, keyString }) => {
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
			const workerPath = '/src/client/store/download-worker.ts';
			const savePath = '/src/client/utils/save-file.ts';
			const { runArchiveDownload } = await import(/* @vite-ignore */ workerPath);
			const { resolveSaveTarget } = await import(/* @vite-ignore */ savePath);
			const filename = format === 'gzip' ? 'decrypted.tar.gz' : 'decrypted.zip';
			const target = await resolveSaveTarget(filename, 'application/octet-stream');
			if (target.kind !== 'stream') throw new Error('Expected stream download');
			return runArchiveDownload({ mode: format === 'gzip' ? 'archive-decrypt' : 'archive-to-zip', fileId: 'parallel-fixture', isTargz: true, filename, encryptionKey: keyString, authHeaders: {}, writable: target.writable }).promise;
		}, { format, keyString });
		const download = await downloadPromise;
		await completion;
		expect(await download.failure()).toBeNull();
		const bytes = await readFile((await download.path())!);
		if (format === 'gzip') {
			expect(bytes[3] & 4).toBe(0);
			expect(digest(gunzipSync(bytes).subarray(512, 512 + raw.length))).toBe(digest(raw));
		} else {
			const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
			const reader = new ZipReader(new Uint8ArrayReader(bytes));
			try {
				const entries = await reader.getEntries();
				expect(entries).toHaveLength(1);
				expect(entries[0].filename).toBe('large.bin');
				if (entries[0].directory) throw new Error('Unexpected directory');
				expect(digest(await entries[0].getData(new Uint8ArrayWriter()))).toBe(digest(raw));
			} finally { await reader.close(); }
		}
	});
}

test('32 MiB serial GETs stage bounded OPFS ranges and remove them after consumption', async ({ page, context }) => {
	const total = 160 * 1024 * 1024 + 19;
	const requests: number[] = [];
	await context.route('**/d/opfs-queue', async route => {
		const match = route.request().headers().range.match(/bytes=(\d+)-(\d+)/)!;
		const start = Number(match[1]); const end = Math.min(Number(match[2]), total - 1);
		expect(Number(match[2]) - start + 1).toBe(32 * 1024 * 1024);
		requests.push(start);
		await route.fulfill({ status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${total}`, ETag: '"opfs-v1"' }, body: Buffer.alloc(end - start + 1, Math.floor(start / (32 * 1024 * 1024))) });
	});
	await page.goto('/');
	const result = await page.evaluate(async () => {
		const path = '/src/client/workers/download-resilience.ts';
		const { createRangedDownloadStream } = await import(/* @vite-ignore */ path);
		let peak = 0; let disk = false; let cleanup!: Promise<void>;
		let filled!: () => void; const full = new Promise<void>(resolve => { filled = resolve; });
		const source = createRangedDownloadStream('/d/opfs-queue', {}, { rangeSize: 32 * 1024 * 1024, readChunkSize: 1024 * 1024, staging: 'opfs', maxBufferedRanges: 4, maxAttempts: 1, requestTimeoutMs: 30000, inactivityTimeoutMs: 30000,
			onCleanup: (p: Promise<void>) => { cleanup = p; },
			onQueue: (bytes: number, onDisk: boolean) => { peak = Math.max(peak, bytes); disk = onDisk; if (bytes === 128 * 1024 * 1024) filled(); },
		});
		const reader = source.getReader();
		const first = (await reader.read()).value!;
		await full;
		const root = await navigator.storage.getDirectory();
		const cache = await root.getDirectoryHandle('download-range-cache-v1');

		async function countFiles() {
			let files = 0; let bytes = 0;
			for await (const [, dir] of cache as any) for await (const [, handle] of dir) { files++; bytes += (await handle.getFile()).size; }
			return { files, bytes };
		}

		const stalled = await countFiles();
		let position = first.length; let valid = first.every((v: number) => v === 0);
		while (true) {
			const { value, done } = await reader.read(); if (done) break;
			valid &&= value.every((v: number, i: number) => v === Math.floor((position + i) / (32 * 1024 * 1024)));
			position += value.length;
		}
		await cleanup;
		return { disk, peak, stalled, after: await countFiles(), position, valid };
	});
	expect(requests).toEqual(Array.from({ length: 6 }, (_, i) => i * 32 * 1024 * 1024));
	expect(result).toEqual({ disk: true, peak: 128 * 1024 * 1024, stalled: { files: 4, bytes: 128 * 1024 * 1024 }, after: { files: 0, bytes: 0 }, position: total, valid: true });
});

test('OPFS cancellation cleans queued ranges and unavailable OPFS retains 32 MiB GETs', async ({ page, context }) => {
	const requests: string[] = [];
	await context.route('**/d/opfs-cancel', async route => {
		const range = route.request().headers().range; requests.push(range);
		const start = Number(range.match(/bytes=(\d+)/)![1]);
		await route.fulfill({ status: 206, headers: { 'Content-Range': `bytes ${start}-${start + 32 * 1024 * 1024 - 1}/${96 * 1024 * 1024}`, ETag: '"cancel-v1"' }, body: Buffer.alloc(32 * 1024 * 1024) });
	});
	await page.goto('/');
	const result = await page.evaluate(async () => {
		const path = '/src/client/workers/download-resilience.ts';
		const { createRangedDownloadStream } = await import(/* @vite-ignore */ path);
		const outputs = [];
		for (const fallback of [false, true]) {
			if (fallback) Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: undefined });
			let cleanup!: Promise<void>; let disk: boolean | undefined;
			const reader = createRangedDownloadStream('/d/opfs-cancel', {}, { rangeSize: 32 * 1024 * 1024, readChunkSize: 1024 * 1024, staging: 'opfs', maxAttempts: 1, requestTimeoutMs: 30000, inactivityTimeoutMs: 30000, onCleanup: (p: Promise<void>) => { cleanup = p; }, onQueue: (_: number, value: boolean) => { disk = value; } }).getReader();
			await reader.read(); await reader.cancel(); await cleanup;
			outputs.push(disk);
			if (fallback) delete (navigator.storage as any).getDirectory;
		}
		const cache = await (await navigator.storage.getDirectory()).getDirectoryHandle('download-range-cache-v1');
		const names = []; for await (const [name] of cache as any) names.push(name);
		return { outputs, names };
	});
	expect(result).toEqual({ outputs: [true, false], names: [] });
	expect(requests.every(value => { const [, a, b] = value.match(/bytes=(\d+)-(\d+)/)!; return Number(b) - Number(a) + 1 === 32 * 1024 * 1024; })).toBe(true);
});

test('range cache removes orphan sessions while preserving a live owner', async ({ page }) => {
	await page.goto('/');
	const result = await page.evaluate(async () => {
		const path = '/src/client/workers/download-range-cache.ts';
		const { createRangeCache, RANGE_CACHE_DIRECTORY } = await import(/* @vite-ignore */ path);
		const live = await createRangeCache(true);
		const sink = await live.create(3); await sink.write(new Uint8Array([1, 2, 3])); const stored = await sink.finish();
		const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(RANGE_CACHE_DIRECTORY);
		const orphan = crypto.randomUUID(); await root.getDirectoryHandle(orphan, { create: true });
		const next = await createRangeCache(true);
		const names = []; for await (const [name] of root as any) names.push(name);
		const bytes = Array.from(await stored.read(0, 3));
		await stored.dispose(); await live.close(); await next.close();
		const after = []; for await (const [name] of root as any) after.push(name);
		return { orphanRemoved: !names.includes(orphan), liveCount: names.length, bytes, after };
	});
	expect(result).toEqual({ orphanRemoved: true, liveCount: 2, bytes: [1, 2, 3], after: [] });
});
