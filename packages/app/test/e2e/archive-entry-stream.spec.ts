import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createBgzfBlock } from 'bgzf';
import { encryptBlob, importAesCtrKey, keyToMultibase } from '../../src/shared/encryption';

for (const format of ['tar', 'targz'] as const) {
	test(`single encrypted ${format} entry streams through SW without OPFS`, async ({ page, context }) => {
		const rawKey = new Uint8Array(32).fill(11);
		const key = await importAesCtrKey(rawKey);
		const original = Buffer.alloc(format === 'tar' ? 32 * 1024 * 1024 + 31 : 1024 * 1024 + 17, 53);
		const encrypted = new Uint8Array(await (await encryptBlob(new Blob([original]), key, new Uint8Array(16).fill(3))).arrayBuffer());
		const prefix = 713, suffix = 29;
		const plain = new Uint8Array(prefix + encrypted.length + suffix); plain.set(encrypted, prefix);
		let archive = plain;
		if (format === 'targz') {
			const blocks: Uint8Array<ArrayBuffer>[] = [];
			for (let i = 0; i < plain.length; i += 32000) blocks.push(await createBgzfBlock(plain.slice(i, i + 32000)));
			archive = new Uint8Array(await new Blob(blocks).arrayBuffer());
		}
		const requests: Array<{ start: number; end: number; hint: string | null }> = [];
		await context.route('**/d/entry-fixture*', async route => {
			const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d+)$/);
			if (!range) throw new Error('Expected a bounded range');
			const start = Number(range[1]), end = Number(range[2]);
			requests.push({ start, end, hint: new URL(route.request().url()).searchParams.get('entry') });
			await route.fulfill({ status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${archive.length}`, ETag: '"entry-fixture"' }, body: Buffer.from(archive.slice(start, end + 1)) });
		});
		await page.goto('/');
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
			Object.defineProperty(navigator.storage, 'getDirectory', { value: () => { throw new Error('No full output OPFS copy'); } });
			Object.defineProperty(window, 'showSaveFilePicker', { value: () => { throw new Error('No picker'); } });
		});
		const downloadPromise = page.waitForEvent('download');
		const completion = page.evaluate(async ({ format, prefix, suffix, size, archiveSize, encryptionKey }) => {
			const saveModule = '/src/client/utils/save-file.ts';
			const workerModule = '/src/client/store/download-worker.ts';
			const { resolveSaveTarget } = await import(/* @vite-ignore */ saveModule);
			const { runDownloadTransform } = await import(/* @vite-ignore */ workerModule);
			const target = await resolveSaveTarget('single.bin', 'application/octet-stream');
			if (target.kind !== 'stream') throw new Error('Expected SW stream');
			const entry = format === 'tar'
				? { type: 'tar', path: 'dir/single.bin', offset: prefix, size }
				: { type: 'targz', path: 'dir/single.bin', aStart: 0, aEnd: archiveSize, rStartOffset: prefix, rEndOffset: suffix };
			return await runDownloadTransform({ mode: 'download', url: '/d/entry-fixture', filename: 'single.bin', mimeType: 'application/octet-stream', transform: 'none', entry, encryptionKey, authHeaders: {}, writable: target.writable }).promise;
		}, { format, prefix, suffix, size: encrypted.length, archiveSize: archive.length, encryptionKey: keyToMultibase(rawKey) });
		const download = await downloadPromise;
		expect((await completion).savedDirectly).toBe(true);
		expect(await download.failure()).toBeNull();
		expect((await readFile((await download.path())!)).equals(original)).toBe(true);
		expect(requests[0].hint).toBe('dir/single.bin');
		expect(requests.slice(1).every(r => r.hint === null)).toBe(true);
		expect(requests.every(r => r.end - r.start + 1 <= 32 * 1024 * 1024)).toBe(true);
		if (format === 'tar') { expect(requests).toHaveLength(2); expect(requests[0].start).toBe(prefix); expect(requests[1].end).toBe(prefix + encrypted.length - 1); }
	});
}

for (const format of ['tar', 'targz'] as const) {
	test(`${format} automatic preview gate performs no entry body fetch`, async ({ page, context }) => {
		await context.route('**/api/meta', route => route.fulfill({ json: {} }));
		await context.route('**/api/files/meta?*', route => route.fulfill({ json: { fileId: 'preview-fixture', isTar: format === 'tar', isTargz: format === 'targz', visibility: 'public', size: 100000000, mimeType: 'application/x-tar' } }));
		let bodyRequests = 0;
		await context.route('**/d/preview-fixture*', route => {
			if (!new URL(route.request().url()).searchParams.has('list')) { bodyRequests++; return route.abort(); }
			return route.fulfill({ json: [format === 'tar'
				? { path: 'large.txt', mimeType: 'text/plain', offset: 512, size: 32 * 1024 * 1024 + 1 }
				: { path: 'large.txt', mimeType: 'text/plain', aStart: 0, aFirstEnd: 100, aFinalStart: 100, aEnd: 200, rStartOffset: 512, rEndOffset: 0 }] });
		});
		await page.goto('/v/fixture/archive.tar/:entries/large.txt');
		await expect(page.getByText('サイズが大きい、またはサイズが不明なためプレビューできません。ダウンロードは利用できます。')).toBeVisible();
		await page.waitForTimeout(300);
		expect(bodyRequests).toBe(0);
	});
}
