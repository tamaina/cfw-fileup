import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createTarHeader } from '../../../bgzf/src';
import { encryptBlob, importAesCtrKey, keyToMultibase } from '../../src/shared/encryption';

for (const kind of ['archive', 'file'] as const) {
	for (const fail of [false, true]) {
		test(`download request and button state during preparation, ${kind}, fail=${fail}`, async ({ page, context, browserName }) => {
			const raw = Buffer.from('early download without corrupting the output');
			const keyBytes = new Uint8Array(32).fill(3);
			const key = await importAesCtrKey(keyBytes);
			const encrypted = Buffer.from(await (await encryptBlob(new Blob([raw]), key, new Uint8Array(16))).arrayBuffer());
			const input = kind === 'file' ? encrypted : Buffer.concat([createTarHeader('payload.bin', encrypted.length, 0), encrypted, Buffer.alloc((512 - encrypted.length % 512) % 512), Buffer.alloc(1024)]);
			let release!: () => void;
			const blocked = new Promise<void>(resolve => { release = resolve; });
			let requests = 0;
			await context.route('**/d/ux-fixture*', async route => {
				if (new URL(route.request().url()).searchParams.has('list')) { await route.fulfill({ json: [] }); return; }
				requests++;
				await blocked;
				await route.fulfill(fail ? { status: 403, body: 'Denied' } : { status: 206, headers: { 'Content-Range': `bytes 0-${input.length - 1}/${input.length}`, ETag: '"ux"' }, body: input });
			});
			await page.goto('/');
			await page.evaluate(async ({ kind, key }) => {
				await navigator.serviceWorker.ready;
				if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
				const module = '/test/e2e/fixtures/download-ux.ts';
				(await import(/* @vite-ignore */ module)).mountDownload(kind, key);
			}, { kind, key: keyToMultibase(keyBytes) });
			const control = page.locator('#download-ux .btn-primary').filter({ hasText: 'ダウンロード' }).first();
			const started = browserName === 'chromium' || !fail ? page.waitForEvent('download') : undefined;
			try {
				await control.click();
				await expect(control).toBeDisabled();
				if (browserName === 'chromium') await started;
				await expect.poll(() => requests).toBe(1);
				await expect(control).toBeDisabled();
				release();
				await expect(control).toBeEnabled({ timeout: 15000 });
				if (fail) {
					if (browserName === 'chromium') expect(await (await started!).failure()).not.toBeNull();
				} else {
					const download = await started!;
					expect(await download.failure()).toBeNull();
					const bytes = await readFile((await download.path())!);
					expect(kind === 'file' ? bytes : bytes.subarray(512, 512 + raw.length)).toEqual(raw);
				}
			} finally { release(); }
		});
	}
}
