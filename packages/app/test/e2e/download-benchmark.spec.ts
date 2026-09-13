import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import ts from 'typescript';
import { createBgzfBlock, createTarHeader } from '../../../bgzf/src';
import { encryptBlob, importAesCtrKey } from '../../src/shared/encryption';

test.skip(!process.env.DOWNLOAD_BENCHMARK, 'Opt-in large download benchmark');
let server: Server;
let origin: string;
let expectedHash: string;
let baseline: string;
let copyOnly: string;
let inputHashes: Record<string, string>;
const baseRevision = process.env.DOWNLOAD_BENCHMARK_BASE ?? '001d6dd5291b2bbb2121faf8ab3cfcc088793a7a';
const size = Number(process.env.DOWNLOAD_BENCHMARK_MIB ?? 32) * 1024 * 1024 + 19;

test.beforeAll(async () => {
	test.setTimeout(120_000);
	const old = execFileSync('git', ['show', `${baseRevision}:packages/bgzf/src/bgzf.ts`], { encoding: 'utf8' });
	const crypto = execFileSync('git', ['show', `${baseRevision}:packages/app/src/shared/encryption.ts`], { encoding: 'utf8' });
	const counter = crypto.slice(crypto.indexOf('function computeCounter'), crypto.indexOf('/**\n * Create a TransformStream that encrypts'));
	const decrypt = crypto.slice(crypto.indexOf('export function createAesCtrDecryptTransform'), crypto.indexOf('/**\n * Encrypt a Blob'));
	const instrument = (source: string) => ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
		transformers: { before: [context => root => {
			const visit: ts.Visitor = node => {
				if (ts.isMethodDeclaration(node) && node.body && node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) && ['transform', 'flush'].includes(node.name.getText())) {
					const prefix = ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([ts.factory.createVariableDeclaration('__started', undefined, undefined, ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('performance'), 'now'), undefined, []))], ts.NodeFlags.Const));
					const finish = ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('globalThis'), 'benchmarkCpuMs'), ts.SyntaxKind.PlusEqualsToken, ts.factory.createBinaryExpression(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('performance'), 'now'), undefined, []), ts.SyntaxKind.MinusToken, ts.factory.createIdentifier('__started'))));
					return ts.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, ts.factory.createBlock([prefix, ts.factory.createTryStatement(node.body, undefined, ts.factory.createBlock([finish]))]));
				}
				return ts.visitEachChild(node, visit, context);
			};
			return ts.visitNode(root, visit) as ts.SourceFile;
		}] },
	}).outputText;
	const cryptoSource = `const AES_CTR_IV_LENGTH=16; const AES_CTR_COUNTER_BITS=128;\n${counter}\n${decrypt}`;
	baseline = instrument(old + '\n' + cryptoSource);
	copyOnly = instrument(old.replace('buf = buf.slice(blockSize);', 'buf = buf.subarray(blockSize);').replace('buf.slice(18, blockSize - 8)', 'buf.subarray(18, blockSize - 8)') + '\n' + cryptoSource);
	const raw = Buffer.alloc(size);
	let state = 713;
	for (let i = 0; i < raw.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; raw[i] = state & 255; }
	expectedHash = createHash('sha256').update(raw).digest('hex');
	const key = await importAesCtrKey(new Uint8Array(32).fill(9));
	const encrypted = Buffer.from(await (await encryptBlob(new Blob([raw]), key, new Uint8Array(16))).arrayBuffer());
	const compress = async (input: Buffer<ArrayBuffer>) => {
		const blocks = [];
		for (let offset = 0; offset < input.length; offset += 64000) blocks.push(await createBgzfBlock(input.subarray(offset, offset + 64000)));
		return Buffer.concat(blocks);
	};
	const fixtures: Record<string, Buffer> = {
		encrypted,
		bgzf: await compress(raw),
		archive: await compress(Buffer.concat([createTarHeader('large.bin', encrypted.length, 0), encrypted, Buffer.alloc((512 - encrypted.length % 512) % 512), Buffer.alloc(1024)])),
	};
	inputHashes = Object.fromEntries(Object.entries(fixtures).map(([kind, bytes]) => [kind, createHash('sha256').update(bytes).digest('hex')]));
	server = createServer((req, res) => {
		if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range, If-Range', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }); res.end(); return; }
		const url = new URL(req.url!, 'http://localhost');
		const bytes = fixtures[url.pathname.slice(1)];
		const match = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
		if (!bytes || !match) { res.writeHead(404); res.end(); return; }
		const start = Number(match[1]); const end = Math.min(Number(match[2]), bytes.length - 1);
		res.writeHead(206, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, ETag', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1, ETag: '"benchmark"' });
		if (url.searchParams.has('slow')) {
			let offset = start;
			const send = () => {
				if (res.destroyed) return;
				if (offset > end) { res.end(); return; }
				res.write(bytes.subarray(offset, Math.min(offset + 65536, end + 1))); offset += 65536;
				setTimeout(send, 8);
			};
			send();
		} else res.end(bytes.subarray(start, end + 1));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing benchmark port');
	origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

for (const scenario of ['fast', 'slow-network', 'slow-save']) {
	for (const kind of ['encrypted', 'bgzf', 'archive']) {
		test(`benchmark ${scenario} ${kind}`, async ({ page, browserName }, info) => {
			test.setTimeout(120_000);
			await page.goto('/');
			const results = [];
			for (const mode of ['baseline', 'copy-only', 'parallel']) {
				const result = await page.evaluate(async ({ mode, kind, url, source, slowSave }) => {
					const schedulerPath = '/src/client/store/download-scheduler.ts';
					const { DownloadScheduler } = await import(/* @vite-ignore */ schedulerPath);
					const broker = new DownloadScheduler(3, navigator.hardwareConcurrency);
					const worker = new Worker('/test/e2e/fixtures/download-benchmark.worker.ts', { type: 'module' });
					const port = mode === 'parallel' ? broker.connect('benchmark') : undefined;
					try {
						const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
							worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
							worker.onerror = event => reject(new Error(event.message));
							worker.postMessage({ mode, kind, url, baseline: source, port, slowSave }, port ? [port] : []);
						});
						return { ...result, snapshot: broker.snapshot(), hardware: navigator.hardwareConcurrency, userAgent: navigator.userAgent };
					} finally { broker.close('benchmark'); worker.terminate(); }
				}, { mode, kind, url: `${origin}/${kind}${scenario === 'slow-network' ? '?slow=1' : ''}`, source: mode === 'copy-only' ? copyOnly : baseline, slowSave: scenario === 'slow-save' });
				expect((result as { hash?: string }).hash).toBe(expectedHash);
				results.push({ browserName, mode, scenario, kind, size, inputHash: inputHashes[kind], ...result });
			}
			console.log('DOWNLOAD_BENCHMARK ' + JSON.stringify(results));
			await info.attach('benchmark.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
		});
	}
}
