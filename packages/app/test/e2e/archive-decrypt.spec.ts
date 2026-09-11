import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { createBgzfBlock, createTarHeader, parseTarStream } from 'bgzf';
import { encryptBlob, importAesCtrKey, keyToMultibase } from '../../src/shared/encryption';

for (const mode of ['tar', 'bgzf-to-tar', 'bgzf-to-gzip'] as const) {
	test(`decrypt archive through SW: ${mode}, retries incomplete input`, async ({ page, context }) => {
		const rawKey = new Uint8Array(32).fill(7);
		const key = await importAesCtrKey(rawKey);
		const originals = Array.from({ length: 9 }, (_, i) => new Uint8Array(i === 8 ? 5 * 1024 * 1024 : i * 17).fill(i));
		const parts: BlobPart[] = [];
		for (const [i, original] of originals.entries()) {
			const encrypted = await encryptBlob(new Blob([original]), key, new Uint8Array(16).fill(i));
			parts.push(createTarHeader(`movies/${i}.MOV`, encrypted.size, 0), encrypted, new Uint8Array((512 - encrypted.size % 512) % 512));
		}
		parts.push(new Uint8Array(1024));
		let archive = new Uint8Array(await new Blob(parts).arrayBuffer());
		if (mode !== 'tar') {
			const blocks: Uint8Array<ArrayBuffer>[] = [];
			for (let offset = 0; offset < archive.length; offset += 16000) blocks.push(await createBgzfBlock(archive.slice(offset, offset + 16000)));
			archive = new Uint8Array(await new Blob(blocks).arrayBuffer());
		}
		let attempts = 0;
		await context.route('**/d/decrypt-fixture', async route => {
			const headers = route.request().headers();
			const match = headers.range?.match(/^bytes=(\d+)-(\d+)$/);
			if (!match) throw new Error('Expected Range request');
			const start = Number(match[1]);
			const end = Math.min(Number(match[2]), archive.length - 1);
			if (start > 0) expect(headers['if-range']).toBe('"encrypted-fixture"');
			attempts++;
			await route.fulfill({ status: 206, headers: {
				'Content-Range': `bytes ${start}-${end}/${archive.length}`,
				ETag: '"encrypted-fixture"',
			}, body: Buffer.from(attempts === 1 ? archive.slice(start, start + 1024) : archive.slice(start, end + 1)) });
		});
		await page.goto('/');
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
		});
		const downloadPromise = page.waitForEvent('download');
		const completion = page.evaluate(async ({ mode, encryptionKey }) => {
			const saveModule = '/src/client/utils/save-file.ts';
			const workerModule = '/src/client/store/download-worker.ts';
			const { resolveSaveTarget } = await import(/* @vite-ignore */ saveModule);
			const { runArchiveDownload } = await import(/* @vite-ignore */ workerModule);
			const target = await resolveSaveTarget('movies.tar', 'application/octet-stream');
			if (target.kind !== 'stream') throw new Error('Expected SW stream');
			return await runArchiveDownload({ mode: 'archive-decrypt', fileId: 'decrypt-fixture', isTargz: mode !== 'tar', decompress: mode !== 'bgzf-to-gzip', filename: 'movies.tar', encryptionKey, authHeaders: {}, writable: target.writable }).promise;
		}, { mode, encryptionKey: keyToMultibase(rawKey) });
		const download = await downloadPromise;
		expect((await completion).savedDirectly).toBe(true);
		expect(await download.failure()).toBeNull();
		expect(attempts).toBe(Math.ceil(archive.length / (4 * 1024 * 1024)) + 1);
		const path = await download.path();
		if (!path) throw new Error('Download path missing');
		const bytes = await readFile(path);
		const tar = mode === 'bgzf-to-gzip' ? gunzipSync(bytes) : bytes;
		let i = 0;
		for await (const entry of parseTarStream(new Blob([tar]).stream())) {
			expect(entry.name).toBe(`movies/${i}.MOV`);
			expect(entry.size).toBe(originals[i].length);
			const chunks: Uint8Array<ArrayBuffer>[] = [];
			for await (const chunk of entry.stream) chunks.push(chunk);
			expect(Buffer.from(await new Blob(chunks).arrayBuffer()).equals(originals[i])).toBe(true);
			i++;
		}
		expect(i).toBe(9);
	});
}
