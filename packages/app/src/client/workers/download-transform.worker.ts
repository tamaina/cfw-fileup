import { isBgzf } from 'bgzf';
import { Conversion, HLS_FORMATS, Input, Mp4OutputFormat, Output, StreamTarget, UrlSource, type StreamTargetChunk } from 'mediabunny';
import { importAesCtrKey, multibaseToKey } from '../../shared/encryption';
import { createOpfsTempFile } from './opfs-temp';
import { createRangedDownloadStream } from './download-resilience';
import { DownloadPipeline, parallelDecrypt, parallelBgzf } from './download-pipeline';
import { DOWNLOAD_RANGE_BYTES, PIPELINE_WINDOW, PROCESS_JOB_BYTES } from './download-processing';

const DOWNLOAD_MAX_ATTEMPTS = 4;
const DOWNLOAD_RANGE_SIZE = DOWNLOAD_RANGE_BYTES;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 30_000;

export type DownloadTransformWorkerRequest = (
	{
		readonly id: string;
		readonly mode: 'download';
		readonly url: string;
		readonly filename: string;
		readonly mimeType: string;
		readonly transform: 'none' | 'decompress-gzip' | 'recompress-bgzf';
		readonly encryptionKey?: string;
		readonly authHeaders: Record<string, string>;
		/** 指定すると OPFS の代わりにこのハンドルへ直接書き込む（構造化複製で渡される） */
		readonly fileHandle?: FileSystemFileHandle;
		readonly writable?: WritableStream<Uint8Array>;
	} | {
		readonly id: string;
		readonly mode: 'hls-to-mp4';
		readonly url: string;
		readonly filename: string;
		readonly token?: string | null;
		readonly authHeaders: Record<string, string>;
		/** 指定すると OPFS の代わりにこのハンドルへ直接書き込む（構造化複製で渡される） */
		readonly fileHandle?: FileSystemFileHandle;
		readonly writable?: WritableStream<Uint8Array>;
	}) & { readonly pipelinePort: MessagePort };

export type DownloadTransformWorkerRequestInput = DownloadTransformWorkerRequest extends infer T
	? T extends DownloadTransformWorkerRequest ? Omit<T, 'id' | 'pipelinePort'> : never
	: never;

export type DownloadTransformProgress = {
	phase: 'reading' | 'writing' | 'done';
	processedFiles: number;
	totalFiles: number;
	currentFile: string;
	completedBytes?: number;
	totalBytes?: number;
	attempt?: number;
	maxAttempts?: number;
	networkStalled?: boolean;
	retrying?: boolean;
};

export type DownloadTransformWorkerMessage =
	| { type: 'progress'; id: string; progress: DownloadTransformProgress }
	| { type: 'done'; id: string; opfsName?: string; savedDirectly: boolean; filename: string; mimeType: string }
	| { type: 'error'; id: string; error: string; opfsName?: string };

self.onmessage = (event: MessageEvent<DownloadTransformWorkerRequest>) => {
	void handleRequest(event.data);
};

async function handleRequest(request: DownloadTransformWorkerRequest): Promise<void> {
	let opfsName: string | undefined;
	const pipeline = new DownloadPipeline(request.pipelinePort);
	try {
		if (request.mode === 'download') await pipeline.start();
		const mimeType = request.mode === 'download' ? request.mimeType : 'video/mp4';
		if (request.mode === 'download' && request.writable) {
			await writeDownload(request.writable, request, pipeline);
			await pipeline.finish();
			post({ type: 'done', id: request.id, savedDirectly: true, filename: request.filename, mimeType });
			return;
		}
		if (request.fileHandle) {
			// showSaveFilePicker で得たハンドルへ出力する（出力全体のOPFSコピーを作らない）
			if (request.mode === 'download') {
				await writeDownload(request.fileHandle, request, pipeline);
			} else {
				await writeHlsMp4(request.fileHandle, request);
			}
			await pipeline.finish();
			post({ type: 'done', id: request.id, savedDirectly: true, filename: request.filename, mimeType });
			return;
		}
		const tempFile = await createOpfsTempFile(request.id, tempExtension(request.filename));
		opfsName = tempFile.opfsName;
		if (request.mode === 'download') {
			await writeDownload(tempFile.fileHandle, request, pipeline);
		} else {
			await writeHlsMp4(tempFile.fileHandle, request);
		}
		await pipeline.finish();
		post({ type: 'done', id: request.id, opfsName, savedDirectly: false, filename: request.filename, mimeType });
	} catch (err) {
		if (request.writable && !request.writable.locked) await request.writable.abort(err).catch(() => {});
		console.error('Download transform worker failed', err, {
			mode: request.mode,
			filename: request.filename,
			opfsName,
		});
		await pipeline.finish().catch(() => {});
		post({ type: 'error', id: request.id, error: err instanceof Error ? err.message : String(err), opfsName });
	} finally { pipeline.close(); }
}

async function writeHlsMp4(fileHandle: FileSystemFileHandle, request: Extract<DownloadTransformWorkerRequest, { mode: 'hls-to-mp4' }>): Promise<void> {
	const writable = await fileHandle.createWritable();
	try {
		let completedBytes = 0;
		progress(request.id, { phase: 'reading', processedFiles: 0, totalFiles: 1, currentFile: request.filename });
		const input = new Input({
			source: new UrlSource(new URL(request.url, location.origin), {
				fetchFn: (input, init) => fetch(withToken(input, request.token), {
					...init,
					headers: {
						...Object.fromEntries(new Headers(init?.headers).entries()),
						...request.authHeaders,
					},
				}),
			}),
			formats: HLS_FORMATS,
		});
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
			target: new StreamTarget(new WritableStream<StreamTargetChunk>({
				async write(chunk) {
					await writable.seek(chunk.position);
					await writable.write(chunk.data);
					completedBytes = Math.max(completedBytes, chunk.position + chunk.data.byteLength);
					progress(request.id, { phase: 'writing', processedFiles: 0, totalFiles: 1, currentFile: request.filename, completedBytes });
				},
			}), { chunked: true }),
		});
		const conversion = await Conversion.init({ input, output, tracks: 'primary' });
		if (!conversion.isValid) {
			const reason = conversion.discardedTracks.map(item => item.reason).join(', ') || 'unknown reason';
			throw new Error(`HLS を MP4 に変換できません: ${reason}`);
		}
		conversion.onProgress = (value) => {
			progress(request.id, { phase: 'writing', processedFiles: value >= 1 ? 1 : 0, totalFiles: 1, currentFile: request.filename, completedBytes });
		};
		await conversion.execute();
		await writable.close();
		input.dispose();
		progress(request.id, { phase: 'done', processedFiles: 1, totalFiles: 1, currentFile: '', completedBytes });
	} catch (err) {
		await writable.abort().catch(() => {});
		throw err;
	}
}

function withToken(input: RequestInfo | URL, token: string | null | undefined): RequestInfo | URL {
	if (!token) return input;
	const url = input instanceof Request ? new URL(input.url) : new URL(input, location.origin);
	if (url.origin === location.origin && !url.searchParams.has('token')) {
		url.searchParams.set('token', token);
	}
	if (input instanceof Request) return new Request(url, input);
	return url;
}

function post(message: DownloadTransformWorkerMessage): void {
	self.postMessage(message);
}

function progress(id: string, progress: DownloadTransformProgress): void {
	post({ type: 'progress', id, progress });
}

function tempExtension(filename: string): string {
	const match = filename.match(/(\.[^./]+)$/);
	return match?.[1] ?? '';
}

async function writeDownload(fileHandle: FileSystemFileHandle | WritableStream<Uint8Array>, request: Extract<DownloadTransformWorkerRequest, { mode: 'download' }>, pipeline: DownloadPipeline): Promise<void> {
	const writable = (fileHandle instanceof WritableStream ? fileHandle : await fileHandle.createWritable()).getWriter();
	let completedBytes = 0;
	let totalBytes = 0;
	let attempt = 1;
	try {
		progress(request.id, {
			phase: 'reading', processedFiles: 0, totalFiles: 1, currentFile: request.filename,
			completedBytes, totalBytes, attempt, maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
		});
		let stream = createRangedDownloadStream(request.url, { headers: request.authHeaders, signal: pipeline.abort.signal }, {
			maxBufferedRanges: PIPELINE_WINDOW,
			staging: 'opfs', readChunkSize: PROCESS_JOB_BYTES, onCleanup: cleanup => pipeline.trackCleanup(cleanup),
			acquireNetwork: () => pipeline.network(),
			rangeSize: DOWNLOAD_RANGE_SIZE,
			maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
			requestTimeoutMs: DOWNLOAD_REQUEST_TIMEOUT_MS,
			inactivityTimeoutMs: DOWNLOAD_INACTIVITY_TIMEOUT_MS,
			onMetadata(bytes) {
				totalBytes = bytes;
			},
			onRangeCommitted(bytes, total) {
				completedBytes = bytes;
				totalBytes = total;
				attempt = 1;
				progress(request.id, {
					phase: 'reading', processedFiles: 0, totalFiles: 1, currentFile: request.filename,
					completedBytes, totalBytes, attempt, maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
				});
			},
			onStall(_rangeStart, stalledAttempt) {
				attempt = stalledAttempt;
				progress(request.id, {
					phase: 'reading', processedFiles: 0, totalFiles: 1, currentFile: request.filename,
					completedBytes, totalBytes, attempt, maxAttempts: DOWNLOAD_MAX_ATTEMPTS, networkStalled: true,
				});
			},
			onRetry(error, rangeStart, nextAttempt, delayMs) {
				attempt = nextAttempt;
				console.warn(`[download-transform] Range starting at ${rangeStart} failed; retrying attempt ${nextAttempt} in ${delayMs}ms`, error);
				progress(request.id, {
					phase: 'reading', processedFiles: 0, totalFiles: 1, currentFile: request.filename,
					completedBytes, totalBytes, attempt, maxAttempts: DOWNLOAD_MAX_ATTEMPTS, retrying: true,
				});
			},
		});

		if (request.encryptionKey) {
			const rawKey = multibaseToKey(request.encryptionKey);
			if (!rawKey) throw new Error('Invalid encryption key');
			const cryptoKey = await importAesCtrKey(rawKey, ['decrypt']);
			stream = parallelDecrypt(stream, cryptoKey, pipeline, true);
		}
		stream = await transformStream(stream, request.transform, pipeline, !request.encryptionKey);
		progress(request.id, {
			phase: 'writing', processedFiles: 0, totalFiles: 1, currentFile: request.filename,
			completedBytes, totalBytes, attempt, maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
		});
		await pipeToWritable(stream, writable);
		await writable.close();
		progress(request.id, {
			phase: 'done', processedFiles: 1, totalFiles: 1, currentFile: '',
			completedBytes: totalBytes || completedBytes, totalBytes, attempt, maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
		});
	} catch (error) {
		await writable.abort().catch(() => {});
		throw error;
	}
}

async function transformStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>, transform: Extract<DownloadTransformWorkerRequest, { mode: 'download' }>['transform'], pipeline: DownloadPipeline, comparable: boolean): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
	if (transform === 'none') return stream;
	const { rebuilt, gzip, bgzf } = await peekStream(stream);
	if (transform === 'decompress-gzip') {
		if (!gzip) return rebuilt;
		return bgzf
			? parallelBgzf(rebuilt, pipeline, comparable)
			: rebuilt.pipeThrough(new DecompressionStream('gzip'));
	}
	if (!bgzf) return rebuilt;
	return parallelBgzf(rebuilt, pipeline, comparable).pipeThrough(new CompressionStream('gzip'));
}

async function peekStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<{
	readonly rebuilt: ReadableStream<Uint8Array<ArrayBuffer>>;
	readonly gzip: boolean;
	readonly bgzf: boolean;
}> {
	const reader = stream.getReader();
	const first = await reader.read();
	reader.releaseLock();
	if (first.done) return { rebuilt: new ReadableStream({ start(c) { c.close(); } }), gzip: false, bgzf: false };
	const remaining = stream.getReader();
	const rebuilt = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			controller.enqueue(first.value!);
		},
		async pull(controller) {
			try {
				const next = await remaining.read();
				if (next.done) {
					remaining.releaseLock();
					controller.close();
				} else {
					controller.enqueue(next.value);
				}
			} catch (error) {
				remaining.releaseLock();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try { await remaining.cancel(reason); } finally { remaining.releaseLock(); }
		},
	});
	const gzip = first.value.length >= 2 && first.value[0] === 0x1f && first.value[1] === 0x8b;
	return { rebuilt, gzip, bgzf: gzip && isBgzf(first.value) };
}

async function pipeToWritable(stream: ReadableStream<Uint8Array<ArrayBuffer>>, writable: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await writable.write(value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}
