/**
 * Web Worker for building tar/zip archives from remote files.
 *
 * Receives a WorkerRequest on startup via postMessage and sends back
 * WorkerProgress updates and a final WorkerResult.
 *
 * This runs in a dedicated worker so that large downloads and CPU-intensive
 * compression don't block the main thread.
 */

import { createTarHeader } from 'bgzf';
import { Zip, ZipPassThrough } from 'fflate';

// ---- Message types ----

export interface WorkerRequest {
	/** Archive format to generate. */
	format: 'tar' | 'zip';
	/** Bucket name used to construct fetch URLs like `/d/<bucket>/<path>`. */
	bucketName: string;
	/** List of file paths (relative to bucket root) to include. */
	filePaths: string[];
	/** Auth token to include as Bearer token. Null for public files. */
	token: string | null;
	/** Desired filename for the download (without extension). */
	baseName: string;
}

export interface WorkerProgress {
	type: 'progress';
	processedFiles: number;
	totalFiles: number;
	currentFile: string;
}

export interface WorkerResult {
	type: 'done';
	blob: Blob;
	filename: string;
}

export interface WorkerError {
	type: 'error';
	message: string;
}

export type WorkerMessage = WorkerProgress | WorkerResult | WorkerError;

// ---- Tar builder ----

/**
 * Build an uncompressed tar archive from a list of remote files.
 * Files are fetched sequentially to keep memory usage low.
 */
async function buildTar(
	filePaths: string[],
	bucketName: string,
	fetchHeaders: HeadersInit,
	onProgress: (i: number, path: string) => void,
): Promise<Uint8Array<ArrayBuffer>> {
	const chunks: Uint8Array[] = [];

	const push = (data: Uint8Array) => { chunks.push(data); };

	for (let i = 0; i < filePaths.length; i++) {
		const path = filePaths[i];
		onProgress(i, path);

		const res = await fetch(`/d/${bucketName}/${path}`, { headers: fetchHeaders });
		if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);

		// Read the full file to know the size before writing the tar header.
		// Tar requires size in the header preceding data, so we must buffer each file.
		const ab = await res.arrayBuffer();
		const data = new Uint8Array(ab);

		const header = createTarHeader(path, data.length, Date.now());
		push(header);
		push(data);

		// Tar data blocks must be padded to 512-byte boundaries
		const padLen = (512 - (data.length % 512)) % 512;
		if (padLen > 0) push(new Uint8Array(padLen));
	}

	// End-of-archive: two 512-byte zero blocks
	push(new Uint8Array(1024));

	const total = chunks.reduce((s, c) => s + c.length, 0);
	const out = new Uint8Array(total) as Uint8Array<ArrayBuffer>;
	let pos = 0;
	for (const c of chunks) { out.set(c, pos); pos += c.length; }
	return out;
}

// ---- Zip builder ----

/**
 * Build a zip archive using fflate's streaming Zip.
 * Each file is fetched and passed through without compression (ZipPassThrough)
 * to avoid excessive CPU usage in the worker.
 */
async function buildZip(
	filePaths: string[],
	bucketName: string,
	fetchHeaders: HeadersInit,
	onProgress: (i: number, path: string) => void,
): Promise<Uint8Array<ArrayBuffer>> {
	return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
		const outputChunks: Uint8Array[] = [];

		const zip = new Zip((err, data, final) => {
			if (err) { reject(err); return; }
			outputChunks.push(data);
			if (final) {
				const total = outputChunks.reduce((s, c) => s + c.length, 0);
				const out = new Uint8Array(total) as Uint8Array<ArrayBuffer>;
				let pos = 0;
				for (const c of outputChunks) { out.set(c, pos); pos += c.length; }
				resolve(out);
			}
		});

		// Process files sequentially using an async IIFE
		(async () => {
			for (let i = 0; i < filePaths.length; i++) {
				const path = filePaths[i];
				onProgress(i, path);

				const res = await fetch(`/d/${bucketName}/${path}`, { headers: fetchHeaders });
				if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);

				const file = new ZipPassThrough(path);
				zip.add(file);

				const reader = res.body!.getReader();
				try {
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							file.push(new Uint8Array(0), true);
							break;
						}
						// false = not the last chunk
						file.push(value, false);
					}
				} finally {
					reader.releaseLock();
				}
			}

			// Signal end of archive to fflate
			zip.end();
		})().catch(reject);
	});
}

// ---- Worker message handler ----

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const req = event.data;
	const { format, bucketName, filePaths, token, baseName } = req;

	const fetchHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

	const onProgress = (i: number, path: string) => {
		const msg: WorkerProgress = {
			type: 'progress',
			processedFiles: i,
			totalFiles: filePaths.length,
			currentFile: path,
		};
		self.postMessage(msg);
	};

	try {
		let data: Uint8Array<ArrayBuffer>;
		let mimeType: string;
		let ext: string;

		if (format === 'tar') {
			data = await buildTar(filePaths, bucketName, fetchHeaders, onProgress);
			mimeType = 'application/x-tar';
			ext = '.tar';
		} else {
			data = await buildZip(filePaths, bucketName, fetchHeaders, onProgress);
			mimeType = 'application/zip';
			ext = '.zip';
		}

		const blob = new Blob([data], { type: mimeType });
		const result: WorkerResult = {
			type: 'done',
			blob,
			filename: baseName + ext,
		};
		self.postMessage(result);
	} catch (err) {
		const errMsg: WorkerError = {
			type: 'error',
			message: err instanceof Error ? err.message : String(err),
		};
		self.postMessage(errMsg);
	}
};
