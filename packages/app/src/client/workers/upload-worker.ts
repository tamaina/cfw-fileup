/// <reference lib="webworker" />

import { readAndCompressImage } from '@misskey-dev/browser-image-resizer';
import { BgzfTarArchiver, TarArchiver, type ArchiveProgress, type TarGzIndex, type TarIndex } from 'bgzf';
import type {
	UploadImageCompressionOptions,
	UploadJobRequest,
	UploadJobSnapshot,
	UploadWorkerFileEntry,
	UploadWorkerClientMessage,
	UploadWorkerServerMessage,
} from './upload-worker-types';

declare const self: SharedWorkerGlobalScope;

interface ApiFailure {
	error: string;
	message?: string;
}

interface OpenUploadResult {
	fileId: string;
	partSize: number;
}

const ports = new Set<MessagePort>();
const jobs: UploadJobSnapshot[] = [];
const queue: Array<{ id: string; request: UploadJobRequest }> = [];
let running = false;
const DEFAULT_NON_RESUME_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024;

self.onconnect = (event) => {
	const port = event.ports[0];
	ports.add(port);
	port.onmessage = (messageEvent: MessageEvent<UploadWorkerClientMessage>) => {
		const message = messageEvent.data;
		if (message.type === 'subscribe') {
			post(port, { type: 'snapshot', jobs });
			return;
		}
		if (message.type === 'enqueue') {
			const id = crypto.randomUUID();
			const now = Date.now();
			jobs.unshift({
				id,
				status: 'queued',
				bucketName: message.job.bucketName,
				prefix: message.job.prefix,
				mode: message.job.mode,
				filename: '',
				fileIndex: 0,
				totalFiles: message.job.files.length,
				uploadedBytes: 0,
				totalBytes: message.job.totalBytes,
				createdAt: now,
				updatedAt: now,
			});
			queue.push({ id, request: message.job });
			post(port, { type: 'enqueued', jobId: id });
			broadcast();
			void pump();
		}
	};
	port.start();
	post(port, { type: 'snapshot', jobs });
};

function post(port: MessagePort, message: UploadWorkerServerMessage): void {
	port.postMessage(message);
}

function broadcast(): void {
	const message: UploadWorkerServerMessage = { type: 'snapshot', jobs };
	for (const port of ports) port.postMessage(message);
}

function updateJob(id: string, patch: Partial<UploadJobSnapshot>): void {
	const job = jobs.find(j => j.id === id);
	if (!job) return;
	Object.assign(job, patch, { updatedAt: Date.now() });
	broadcast();
}

async function pump(): Promise<void> {
	if (running) return;
	running = true;
	try {
		while (queue.length > 0) {
			const item = queue.shift()!;
			updateJob(item.id, { status: 'running' });
			try {
				const result = await executeUpload(item.id, item.request);
				updateJob(item.id, { status: 'done', uploadedBytes: result.totalBytes, totalBytes: result.totalBytes, completedPath: result.completedPath });
			} catch (err) {
				updateJob(item.id, { status: 'error', error: err instanceof Error ? err.message : String(err) });
			}
		}
	} finally {
		running = false;
	}
}

function authHeaders(token: string | null): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiPost<T>(endpoint: string, body: unknown, token: string | null): Promise<T> {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
		body: JSON.stringify(body ?? {}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((data as ApiFailure).message ?? `HTTP ${res.status}`);
	return data as T;
}

async function getResumeOffset(fileId: string, token: string | null): Promise<number> {
	const res = await fetch(`/upload/${fileId}/resume`, {
		headers: { 'Tus-Resumable': '1.0.0', ...authHeaders(token) },
	}).catch(() => null);
	if (!res?.ok) return -1;
	return parseInt(res.headers.get('Upload-Offset') ?? '-1', 10);
}

async function getUploadPartCount(fileId: string, token: string | null): Promise<number> {
	const result = await apiPost<{ partCount: number }>('/api/files/create/status', { fileId }, token).catch(() => null);
	return result?.partCount ?? -1;
}

async function openUpload(path: string, request: UploadJobRequest): Promise<OpenUploadResult> {
	const result = await apiPost<{ fileId: string; partSize: number }>('/api/files/create/open', {
		bucketId: request.bucketId,
		path,
		partSize: request.partSize,
	}, request.authToken);
	return { fileId: result.fileId, partSize: result.partSize };
}

async function closeUpload(fileId: string, request: UploadJobRequest): Promise<void> {
	await apiPost('/api/files/create/close', {
		fileId,
		visibility: request.visibility,
		isListed: request.isListed,
		passphrase: request.passphrase || undefined,
		isDownloadCountEnabled: request.isDownloadCountEnabled ?? false,
		isDownloadCountVisible: request.isDownloadCountEnabled ? request.isDownloadCountVisible ?? false : false,
	}, request.authToken);
}

async function deleteExistingFile(path: string, request: UploadJobRequest): Promise<void> {
	await apiPost('/api/files/delete', { bucketId: request.bucketId, path }, request.authToken);
}

async function tusUpload(fileId: string, blob: Blob, path: string, partSize: number, request: UploadJobRequest, onProgress: (uploaded: number) => void): Promise<void> {
	const total = blob.size;
	let offset = Math.max(0, await getResumeOffset(fileId, request.authToken));
	onProgress(offset);

	while (offset < total) {
		const chunk = blob.slice(offset, offset + partSize);
		const chunkIndex = offset / partSize;
		let success = false;

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(`/upload/${fileId}/resume`, {
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/offset+octet-stream',
						'Upload-Offset': String(offset),
						'Content-Length': String(chunk.size),
						'Tus-Resumable': '1.0.0',
						...authHeaders(request.authToken),
					},
					body: chunk,
				});
				if (res.ok) { success = true; break; }
				if (res.status >= 400 && res.status < 500) {
					const err = (await res.json().catch(() => ({}))) as ApiFailure;
					throw new Error(`アップロード失敗 (${path}): ${err.message ?? res.status}`);
				}
			} catch (err) {
				if (attempt >= 2) throw err;
				await delay(1000 * (attempt + 1));
				const partCount = await getUploadPartCount(fileId, request.authToken);
				if (partCount > chunkIndex) {
					offset = partCount * partSize;
					onProgress(offset);
					success = true;
					break;
				}
			}
			if (attempt < 2) await delay(1000 * (attempt + 1));
		}

		if (!success) throw new Error(`アップロード失敗 (${path}): ネットワークエラー（リトライ上限）`);
		offset += chunk.size;
		onProgress(offset);
	}
}

async function nonResumeUpload(fileId: string, blob: Blob, path: string, request: UploadJobRequest, onProgress: (uploaded: number) => void): Promise<void> {
	const res = await fetch(`/upload/${fileId}`, {
		method: 'PUT',
		headers: {
			'Content-Type': blob.type || 'application/octet-stream',
			'Content-Length': String(blob.size),
			...authHeaders(request.authToken),
		},
		body: blob,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as ApiFailure;
		throw new Error(`アップロード失敗 (${path}): ${err.message ?? res.status}`);
	}
	onProgress(blob.size);
}

async function uploadBlob(blob: Blob, path: string, request: UploadJobRequest, onProgress: (uploaded: number) => void): Promise<void> {
	const { fileId, partSize } = await openUpload(path, request);
	try {
		const nonResumeUploadLimitBytes = request.nonResumeUploadLimitBytes ?? DEFAULT_NON_RESUME_UPLOAD_LIMIT_BYTES;
		if (blob.size < nonResumeUploadLimitBytes) {
			await nonResumeUpload(fileId, blob, path, request, onProgress);
		} else {
			await tusUpload(fileId, blob, path, partSize, request, onProgress);
		}
		await closeUpload(fileId, request);
	} catch (err) {
		await deleteExistingFile(path, request).catch(() => {});
		throw err;
	}
}

async function uploadStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>, path: string, request: UploadJobRequest, onProgress: (uploaded: number) => void): Promise<void> {
	const fileId = await uploadChunkedStream(stream, path, request, onProgress);
	await closeUpload(fileId, request);
}

async function uploadArchiveStream(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	index: Promise<TarIndex[] | TarGzIndex[]>,
	archivePath: string,
	indexEndpoint: '/api/files/create/tar-index' | '/api/files/create/targz-index',
	request: UploadJobRequest,
	onProgress: (uploaded: number) => void,
): Promise<void> {
	const { fileId, partSize } = await openUpload(archivePath, request);
	try {
		await writeStreamParts(fileId, partSize, stream, archivePath, request, onProgress);
		await apiPost(indexEndpoint, { fileId, files: await index }, request.authToken);
		await closeUpload(fileId, request);
	} catch (err) {
		await deleteExistingFile(archivePath, request).catch(() => {});
		throw err;
	}
}

async function uploadChunkedStream(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	path: string,
	request: UploadJobRequest,
	onProgress: (uploaded: number) => void,
): Promise<string> {
	const { fileId, partSize } = await openUpload(path, request);
	try {
		await writeStreamParts(fileId, partSize, stream, path, request, onProgress);
		return fileId;
	} catch (err) {
		await deleteExistingFile(path, request).catch(() => {});
		throw err;
	}
}

async function writeStreamParts(
	fileId: string,
	partSize: number,
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	path: string,
	request: UploadJobRequest,
	onProgress: (uploaded: number) => void,
): Promise<void> {
	const reader = stream.getReader();
	const queue = new TusChunkQueue(fileId, path, partSize, request, onProgress);
	let buf = new Uint8Array(0);
	let offset = 0;
	let partNum = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (value) {
				const next = new Uint8Array(buf.length + value.length);
				next.set(buf);
				next.set(value, buf.length);
				buf = next;
			}

			while (buf.length >= partSize) {
				const chunk = buf.slice(0, partSize);
				buf = buf.slice(partSize);
				await queue.appendChunk(chunk, offset, partNum++, false);
				offset += chunk.length;
			}

			if (done) {
				while (buf.length > 0) {
					const isFinal = buf.length <= partSize;
					const chunk = isFinal ? buf : buf.slice(0, partSize);
					buf = buf.slice(chunk.length);
					await queue.appendChunk(chunk, offset, partNum++, isFinal);
					offset += chunk.length;
				}
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	await queue.waitAll();
}

class TusChunkQueue {
	private queueChain: Promise<void> = Promise.resolve();
	private hasError = false;
	private pendingUploads: Promise<void>[] = [];

	constructor(
		private readonly fileId: string,
		private readonly path: string,
		private readonly partSize: number,
		private readonly request: UploadJobRequest,
		private readonly onUploadedBytes: (total: number) => void,
	) {}

	async appendChunk(chunk: Uint8Array<ArrayBuffer>, offset: number, partNum: number, isFinal: boolean): Promise<void> {
		const tmpName = `__chunk_${Date.now()}_${partNum}_${crypto.randomUUID()}`;
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(tmpName, { create: true });
		const writable = await handle.createWritable();
		await writable.write(chunk);
		await writable.close();
		this.queueUpload({ handle, tmpName, offset, partNum, length: chunk.length, isFinal });
	}

	private queueUpload(info: {
		handle: FileSystemFileHandle;
		tmpName: string;
		offset: number;
		partNum: number;
		length: number;
		isFinal: boolean;
	}): void {
		const promise = this.queueChain.then(async () => {
			if (this.hasError) throw new Error(`アップロード失敗 (${this.path})`);
			await this.sendChunk(info);
			this.onUploadedBytes(info.offset + info.length);
		}).catch((err) => {
			this.hasError = true;
			throw err;
		});

		this.queueChain = promise.catch(() => {});
		this.pendingUploads.push(promise);
	}

	private async sendChunk(info: {
		handle: FileSystemFileHandle;
		tmpName: string;
		offset: number;
		partNum: number;
		isFinal: boolean;
	}): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const file = await info.handle.getFile();
			const extraHeaders: Record<string, string> = { 'Content-Length': String(file.size) };
			if (info.isFinal) extraHeaders['Upload-Final'] = '1';

			try {
				const res = await fetch(`/upload/${this.fileId}/resume`, {
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/offset+octet-stream',
						'Upload-Offset': String(info.offset),
						'Tus-Resumable': '1.0.0',
						...authHeaders(this.request.authToken),
						...extraHeaders,
					},
					body: file,
				});

				if (res.ok) {
					await deleteFromOpfs(info.tmpName);
					return;
				}

				if (res.status >= 400 && res.status < 500) {
					await deleteFromOpfs(info.tmpName);
					const err = (await res.json().catch(() => ({}))) as ApiFailure;
					throw new Error(`アップロード失敗 (${this.path}): ${err.message ?? res.status}`);
				}
			} catch (err) {
				if (attempt >= 2) throw err;
				await delay(1000 * (attempt + 1));
				const partCount = await getUploadPartCount(this.fileId, this.request.authToken);
				if (partCount > info.partNum) {
					await deleteFromOpfs(info.tmpName);
					return;
				}
			}

			if (attempt < 2) await delay(1000 * (attempt + 1));
		}

		await deleteFromOpfs(info.tmpName);
		throw new Error(`アップロード失敗 (${this.path}): ネットワークエラー（リトライ上限）`);
	}

	async waitAll(): Promise<void> {
		await Promise.all(this.pendingUploads);
		if (this.hasError) throw new Error(`アップロード失敗 (${this.path})`);
	}
}

async function deleteFromOpfs(name: string): Promise<void> {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(name).catch(() => {});
}

type PreparedUploadEntry = UploadWorkerFileEntry & {
	readonly originalSize: number;
};

function isImageCompressionEnabled(request: UploadJobRequest): request is UploadJobRequest & { imageCompression: UploadImageCompressionOptions } {
	return request.mode === 'individual' && request.imageCompression?.enabled === true;
}

function compressedImagePathForMimeType(path: string, mimeType: UploadImageCompressionOptions['mimeType']): string {
	const extension = mimeType === 'image/webp' ? '.webp' : '.jpg';
	const dot = path.lastIndexOf('.');
	const slash = path.lastIndexOf('/');
	if (dot > slash) return `${path.slice(0, dot)}${extension}`;
	return `${path}${extension}`;
}

async function canEncodeImageMimeType(mimeType: UploadImageCompressionOptions['mimeType']): Promise<boolean> {
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(1, 1);
		const blob = await canvas.convertToBlob({ type: mimeType }).catch(() => null);
		if (blob?.type === mimeType) return true;
	}
	return mimeType === 'image/jpeg';
}

async function resolveImageCompressionMimeType(mimeType: UploadImageCompressionOptions['mimeType']): Promise<UploadImageCompressionOptions['mimeType']> {
	if (mimeType === 'image/jpeg') return 'image/jpeg';
	return await canEncodeImageMimeType('image/webp') ? 'image/webp' : 'image/jpeg';
}

async function prepareUploadEntry(entry: UploadWorkerFileEntry, request: UploadJobRequest): Promise<PreparedUploadEntry> {
	if (!isImageCompressionEnabled(request) || !entry.file.type.startsWith('image/')) {
		return { ...entry, originalSize: entry.file.size };
	}

	const mimeType = await resolveImageCompressionMimeType(request.imageCompression.mimeType);
	const blob = await readAndCompressImage(entry.file, {
		quality: request.imageCompression.quality,
		maxWidth: request.imageCompression.maxWidth,
		maxHeight: request.imageCompression.maxHeight,
		mimeType,
		argorithm: null,
		processByHalf: true,
	});
	const name = compressedImagePathForMimeType(entry.file.name, mimeType);
	return {
		path: compressedImagePathForMimeType(entry.path, mimeType),
		file: new File([blob], name, { type: mimeType, lastModified: entry.file.lastModified }),
		originalSize: entry.file.size,
	};
}

async function executeUpload(id: string, request: UploadJobRequest): Promise<{ completedPath: string; totalBytes: number }> {
	const files = request.files;
	let cumulativeBytes = 0;
	let totalBytes = request.totalBytes;
	let completedPath = '';

	if (request.mode === 'individual' || request.mode === 'gz') {
		for (let i = 0; i < files.length; i++) {
			const entry = files[i];
			updateJob(id, { filename: entry.path, fileIndex: i, totalFiles: files.length, uploadedBytes: cumulativeBytes });
			const preparedEntry = await prepareUploadEntry(entry, request);
			if (preparedEntry.file.size !== preparedEntry.originalSize || preparedEntry.path !== entry.path) {
				totalBytes += preparedEntry.file.size - preparedEntry.originalSize;
				request.totalBytes = totalBytes;
				updateJob(id, { filename: preparedEntry.path, totalBytes });
			}
			const path = request.mode === 'gz' ? `${request.prefix}${preparedEntry.path}.gz` : `${request.prefix}${preparedEntry.path}`;
			if (request.mode === 'gz') {
				await uploadStream(preparedEntry.file.stream().pipeThrough(new CompressionStream('gzip')), path, request, (n) => {
					updateJob(id, { uploadedBytes: cumulativeBytes + n });
				});
			} else {
				await uploadBlob(preparedEntry.file, path, request, (n) => {
					updateJob(id, { uploadedBytes: cumulativeBytes + n });
				});
			}
			cumulativeBytes += preparedEntry.file.size;
			completedPath = path;
			updateJob(id, { fileIndex: i + 1, uploadedBytes: cumulativeBytes });
		}
		return { completedPath, totalBytes };
	}

	updateJob(id, { filename: '', fileIndex: 0, totalFiles: 0, uploadedBytes: 0 });
	if (request.mode === 'tar') {
		const archivePath = `${request.prefix}${request.archiveBaseName}.tar`;
		const archiver = await TarArchiver.createFromEntries(files, (p: ArchiveProgress) => {
			updateJob(id, { filename: p.currentFile, fileIndex: p.processedFiles, totalFiles: p.totalFiles });
		});
		await uploadArchiveStream(archiver.stream, archiver.index, archivePath, '/api/files/create/tar-index', request, (n) => {
			updateJob(id, { uploadedBytes: n });
		});
		return { completedPath: archivePath, totalBytes };
	}

	const archivePath = `${request.prefix}${request.archiveBaseName}.tar.gz`;
	const archiver = await BgzfTarArchiver.createFromEntries(files, (p: ArchiveProgress) => {
		updateJob(id, { filename: p.currentFile, fileIndex: p.processedFiles, totalFiles: p.totalFiles });
	});
	await uploadArchiveStream(archiver.stream, archiver.index, archivePath, '/api/files/create/targz-index', request, (n) => {
		updateJob(id, { uploadedBytes: n });
	});
	return { completedPath: archivePath, totalBytes };
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
