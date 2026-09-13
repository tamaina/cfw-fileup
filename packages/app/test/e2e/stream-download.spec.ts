import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { createBgzfBlock } from '../../../bgzf/src/index';

// Exercise the real SW, transferable streams and download-transform Worker together.
for (const transform of ['decompress-gzip', 'recompress-bgzf'] as const) {
	test(`SW download: ${transform}, without OPFS or picker`, async ({ page, context }) => {
		const original = Buffer.from('ストリーム保存の検証\n'.repeat(2000));
		const blocks: Uint8Array[] = [];
		for (let offset = 0; offset < original.length; offset += 16000) {
			blocks.push(await createBgzfBlock(original.subarray(offset, offset + 16000)));
		}
		const bgzf = Buffer.concat(blocks);
		await context.route('**/__test_bgzf', route => route.fulfill({
			status: 206,
			headers: { 'Content-Range': `bytes 0-${bgzf.length - 1}/${bgzf.length}`, 'Content-Length': String(bgzf.length), 'ETag': '"fixture"' },
			body: bgzf,
		}));
		await page.goto('/');
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) {
				await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
			}
			Object.defineProperty(navigator.storage, 'getDirectory', { value: () => { throw new Error('OPFS must not be used'); } });
			Object.defineProperty(window, 'showSaveFilePicker', { value: () => { throw new Error('Picker must not be used'); } });
		});
		const downloadPromise = page.waitForEvent('download');
		const completion = page.evaluate(async (transform) => {
			const saveModule = '/src/client/utils/save-file.ts';
			const workerModule = '/src/client/store/download-worker.ts';
			const { resolveSaveTarget } = await import(/* @vite-ignore */ saveModule);
			const { runDownloadTransform } = await import(/* @vite-ignore */ workerModule);
			const target = await resolveSaveTarget('検証.tar' + (transform === 'recompress-bgzf' ? '.gz' : ''), 'application/octet-stream');
			if (target.kind !== 'stream') throw new Error(`Unexpected save target: ${target.kind}`);
			return await runDownloadTransform({ mode: 'download', url: '/__test_bgzf', filename: '検証.tar', mimeType: 'application/octet-stream', transform, authHeaders: {}, writable: target.writable }).promise;
		}, transform);
		const download = await downloadPromise;
		const result = await completion;
		expect(result.savedDirectly).toBe(true);
		expect(result.opfsName).toBeUndefined();
		expect(await download.failure()).toBeNull();
		expect(download.suggestedFilename()).toBe('検証.tar' + (transform === 'recompress-bgzf' ? '.gz' : ''));
		const bytes = await readFile((await download.path())!);
		expect(transform === 'recompress-bgzf' ? gunzipSync(bytes) : bytes).toEqual(original);
		if (transform === 'recompress-bgzf') expect(bytes[3] & 4).toBe(0); // ordinary gzip, no BGZF extra field
	});
}

for (const format of ['tar', 'zip'] as const) {
	test(`SW download: directory as ${format}`, async ({ page, context }) => {
		const original = Buffer.from('archive entry content\n');
		await context.route('**/d/stream-fixture', route => route.fulfill({ body: original }));
		await page.goto('/');
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
		});
		const downloadPromise = page.waitForEvent('download');
		const completion = page.evaluate(async ({ format, size }) => {
			const saveModule = '/src/client/utils/save-file.ts';
			const workerModule = '/src/client/store/download-worker.ts';
			const { resolveSaveTarget } = await import(/* @vite-ignore */ saveModule);
			const { runArchiveDownload } = await import(/* @vite-ignore */ workerModule);
			const filename = `archive.${format}`;
			const target = await resolveSaveTarget(filename, 'application/octet-stream');
			if (target.kind !== 'stream') throw new Error('Expected stream');
			return await runArchiveDownload({ mode: 'directory', format, filename, bucketName: 'fixture', basePath: '', targets: [{ type: 'file', path: 'entry.txt', fileId: 'stream-fixture', size }], excludePaths: [], authHeaders: {}, writable: target.writable }).promise;
		}, { format, size: original.length });
		const download = await downloadPromise;
		expect((await completion).savedDirectly).toBe(true);
		expect(await download.failure()).toBeNull();
		const bytes = await readFile((await download.path())!);
		if (format === 'tar') {
			expect(bytes.subarray(0, 9).toString()).toBe('entry.txt');
			expect(bytes.subarray(512, 512 + original.length)).toEqual(original);
		} else {
			const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
			const reader = new ZipReader(new Uint8ArrayReader(bytes));
			const entries = await reader.getEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0].filename).toBe('entry.txt');
			if (entries[0].directory) throw new Error('Unexpected directory');
			expect(Buffer.from(await entries[0].getData(new Uint8ArrayWriter()))).toEqual(original);
			await reader.close();
		}
	});
}

test('SW download: producer abort fails the browser download', async ({ page, browserName }) => {
	test.skip(browserName === 'firefox', 'Firefox Playwright download.failure() does not settle on SW response errors; see stream-download-lifetime.spec.ts.');
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
	});
	const downloadPromise = page.waitForEvent('download');
	await page.evaluate(async () => {
		const modulePath = '/src/client/utils/stream-download.ts';
		const { createStreamDownload } = await import(/* @vite-ignore */ modulePath);
		const writable = await createStreamDownload('interrupted.bin');
		if (!writable) throw new Error('Expected stream');
		const writer = writable.getWriter();
		await writer.write(new Uint8Array(1024));
		(window as any).abortTestDownload = async () => {
			await writer.abort(new Error('test failure'));
			const { finishStreamDownload } = await import(/* @vite-ignore */ modulePath);
			finishStreamDownload(writable, true);
		};
	});
	const download = await downloadPromise;
	await page.evaluate(() => (window as any).abortTestDownload());
	expect(await download.failure()).not.toBeNull();
});
