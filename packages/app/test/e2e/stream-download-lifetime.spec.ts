import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import ts from 'typescript';

declare global {
	interface Window {
		streamTest: {
			write: (value: number) => Promise<void>;
			close: () => Promise<void>;
			fail: () => void;
		};
	}
}

let server: Server;
let origin: string;
const idleMs = Number(process.env.STREAM_DOWNLOAD_IDLE_MS ?? 45_000);

test.beforeAll(async () => {
	test.setTimeout(60_000);
	const compile = (source: string): string => ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
	}).outputText;
	const sw = compile(await readFile(new URL('../../src/sw/stream-download.ts', import.meta.url), 'utf8'))
		+ '\nself.addEventListener("install",()=>self.skipWaiting()); self.addEventListener("activate",e=>e.waitUntil(self.clients.claim())); installStreamDownloads(self);';
	const client = compile(await readFile(new URL('../../src/client/utils/stream-download.ts', import.meta.url), 'utf8'));
	server = createServer((request, response) => {
		response.setHeader('Content-Type', request.url?.endsWith('.js') ? 'text/javascript' : 'text/html');
		response.end(request.url === '/sw.js' ? sw : request.url === '/client.js' ? client : '<!doctype html><title>Stream download test</title>');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing server port');
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (!server) return;
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test.beforeEach(async ({ page }) => {
	await page.goto(origin);
	await page.evaluate(async () => {
		await navigator.serviceWorker.register('/sw.js', { type: 'module' });
		await navigator.serviceWorker.ready;
	});
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);
});

async function startDownload(page: import('@playwright/test').Page, filename: string): Promise<void> {
	await page.evaluate(async (filename) => {
		const path = '/client.js';
		const { createStreamDownload, finishStreamDownload } = await import(/* @vite-ignore */ path);
		const writable = await createStreamDownload(filename);
		if (!writable) throw new Error('Expected stream download');
		// Writable の転送後でもページから中止できることを検証する。
		const worker = new Worker(URL.createObjectURL(new Blob([`
			let writer;
			onmessage = async ({data}) => {
				try {
					if (data.writable) writer = data.writable.getWriter();
					else if (data.close) await writer.close();
					else await writer.write(new Uint8Array(65536).fill(data.value));
					postMessage({});
				} catch (error) { postMessage({error:String(error)}); }
			};
		`], { type: 'text/javascript' })));
		const send = (message: object, transfer: Transferable[] = []): Promise<void> => new Promise((resolve, reject) => {
			worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve();
			worker.postMessage(message, transfer);
		});
		await send({ writable }, [writable]);
		window.streamTest = {
			write: value => send({ value }),
			async close() {
				await send({ close: true });
				finishStreamDownload(writable);
				worker.terminate();
			},
			fail() {
				worker.terminate();
				finishStreamDownload(writable, true);
			},
		};
		await window.streamTest.write(1);
	}, filename);
}

test('retains the entire download across an idle period and another tab', async ({ page, context }) => {
	test.setTimeout(idleMs + 30_000);
	const downloadPromise = page.waitForEvent('download');
	await startDownload(page, 'idle.bin');
	const download = await downloadPromise;
	let completed = false;
	const completion = download.failure().then(failure => { completed = true; return failure; });
	const other = await context.newPage();
	await other.goto('about:blank');
	await other.bringToFront();
	// 実時間で idle timeout を越える。SW への ping やブラウザ操作を挟まない。
	await new Promise(resolve => setTimeout(resolve, idleMs));
	expect(completed, 'Browser must not report completion before the producer closes').toBe(false);
	await page.evaluate(async () => { await window.streamTest.write(2); await window.streamTest.close(); });
	expect(await completion).toBeNull();
	const path = await download.path();
	if (!path) throw new Error('Missing downloaded file');
	expect(await readFile(path)).toEqual(Buffer.concat([Buffer.alloc(65536, 1), Buffer.alloc(65536, 2)]));
});

test('terminating a producer fails the download after transferring its writable', async ({ page, browserName }) => {
	test.skip(browserName === 'firefox', 'Firefox emits a ServiceWorker response error but Playwright download.failure() never settles; abort reporting remains unverified.');
	const downloadPromise = page.waitForEvent('download');
	await startDownload(page, 'aborted.bin');
	const download = await downloadPromise;
	await page.evaluate(() => window.streamTest.fail());
	expect(await download.failure()).not.toBeNull();
});

test('successive downloads retain complete contents', async ({ page }) => {
	for (let index = 0; index < 3; index++) {
		const downloadPromise = page.waitForEvent('download');
		await startDownload(page, `sequential-${index}.bin`);
		const download = await downloadPromise;
		await page.evaluate(() => window.streamTest.close());
		expect(await download.failure()).toBeNull();
		const path = await download.path();
		if (!path) throw new Error('Missing downloaded file');
		expect(await readFile(path)).toEqual(Buffer.alloc(65536, 1));
	}
});
