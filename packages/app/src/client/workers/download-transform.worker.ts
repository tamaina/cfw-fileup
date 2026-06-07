import { createBgzfDecompressor, isBgzf } from 'bgzf';
import { createOpfsTempFile } from './opfs-temp';

export type DownloadTransformWorkerRequest =
	{
		readonly id: string;
		readonly mode: 'download';
		readonly url: string;
		readonly filename: string;
		readonly mimeType: string;
		readonly transform: 'none' | 'decompress-gzip' | 'recompress-bgzf';
		readonly authHeaders: Record<string, string>;
	};

export type DownloadTransformProgress = {
	phase: 'reading' | 'writing' | 'done';
	processedFiles: number;
	totalFiles: number;
	currentFile: string;
	completedBytes?: number;
	totalBytes?: number;
};

export type DownloadTransformWorkerMessage =
	| { type: 'progress'; id: string; progress: DownloadTransformProgress }
	| { type: 'done'; id: string; opfsName: string; filename: string; mimeType: string }
	| { type: 'error'; id: string; error: string; opfsName?: string };

self.onmessage = (event: MessageEvent<DownloadTransformWorkerRequest>) => {
	void handleRequest(event.data);
};

async function handleRequest(request: DownloadTransformWorkerRequest): Promise<void> {
	let opfsName: string | undefined;
	try {
		const tempFile = await createOpfsTempFile(request.id, tempExtension(request.filename));
		opfsName = tempFile.opfsName;
		await writeDownload(tempFile.fileHandle, request);
		post({ type: 'done', id: request.id, opfsName, filename: request.filename, mimeType: request.mimeType });
	} catch (err) {
		post({ type: 'error', id: request.id, error: err instanceof Error ? err.message : String(err), opfsName });
	}
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

async function writeDownload(fileHandle: FileSystemFileHandle, request: Extract<DownloadTransformWorkerRequest, { mode: 'download' }>): Promise<void> {
	const writable = await fileHandle.createWritable();
	try {
		progress(request.id, { phase: 'reading', processedFiles: 0, totalFiles: 1, currentFile: request.filename });
		const res = await fetch(request.url, { headers: request.authHeaders });
		if (!res.ok || !res.body) throw new Error(`Failed to fetch file: HTTP ${res.status}`);
		const totalBytes = Number(res.headers.get('Content-Length')) || 0;
		let completedBytes = 0;
		const progressBody = totalBytes > 0
			? withByteProgress(res.body, (bytes) => {
				completedBytes += bytes;
				progress(request.id, { phase: 'reading', processedFiles: 0, totalFiles: 1, currentFile: request.filename, completedBytes, totalBytes });
			})
			: res.body;
		const stream = await transformStream(progressBody, request.transform);
		progress(request.id, { phase: 'writing', processedFiles: 0, totalFiles: 1, currentFile: request.filename, completedBytes, totalBytes });
		await pipeToWritable(stream, writable);
		await writable.close();
		progress(request.id, { phase: 'done', processedFiles: 1, totalFiles: 1, currentFile: '', completedBytes: totalBytes, totalBytes });
	} catch (err) {
		await writable.abort().catch(() => {});
		throw err;
	}
}

function withByteProgress(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	onChunk: (bytes: number) => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
	return stream.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
		transform(chunk, controller) {
			onChunk(chunk.byteLength);
			controller.enqueue(chunk);
		},
	}));
}

async function transformStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>, transform: Extract<DownloadTransformWorkerRequest, { mode: 'download' }>['transform']): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
	if (transform === 'none') return stream;
	const { rebuilt, gzip, bgzf } = await peekStream(stream);
	if (transform === 'decompress-gzip') {
		if (!gzip) return rebuilt;
		return bgzf
			? rebuilt.pipeThrough(createBgzfDecompressor())
			: rebuilt.pipeThrough(new DecompressionStream('gzip'));
	}
	if (!bgzf) return rebuilt;
	return rebuilt.pipeThrough(createBgzfDecompressor()).pipeThrough(new CompressionStream('gzip'));
}

async function peekStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<{
	readonly rebuilt: ReadableStream<Uint8Array<ArrayBuffer>>;
	readonly gzip: boolean;
	readonly bgzf: boolean;
}> {
	const reader = stream.getReader();
	const first = await reader.read();
	reader.releaseLock();
	if (first.done || !first.value) throw new Error('Download is empty');
	const rebuilt = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			controller.enqueue(first.value!);
			void stream.pipeTo(new WritableStream({
				write(chunk) {
					controller.enqueue(chunk);
				},
				close() {
					controller.close();
				},
				abort(reason) {
					controller.error(reason);
				},
			})).catch(error => controller.error(error));
		},
	});
	const gzip = first.value.length >= 2 && first.value[0] === 0x1f && first.value[1] === 0x8b;
	return { rebuilt, gzip, bgzf: gzip && isBgzf(first.value) };
}

async function pipeToWritable(stream: ReadableStream<Uint8Array<ArrayBuffer>>, writable: FileSystemWritableFileStream): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await writable.write(value);
		}
	} finally {
		reader.releaseLock();
	}
}
