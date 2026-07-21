/// <reference lib="webworker" />

import { BgzfTarArchiver, detectMimeType, type ArchiveProgress, type TarGzIndex, type TarIndex } from 'bgzf';
import type { FileEntry } from 'bgzf';
import { createTarArchive } from '../utils/tar-archive';
import {
	createAesCtrEncryptTransform,
	generateIv,
	generateRawKey,
	importAesCtrKey,
	keyToMultibase,
} from '../../shared/encryption';
import type {
	UploadJobRequest,
	UploadJobSnapshot,
	UploadResolvedEntry,
	UploadStreamingJobRequest,
	UploadWorkerClientMessage,
	UploadWorkerEntry,
	UploadWorkerFileEntry,
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

interface StreamingJob {
	id: string;
	request: UploadStreamingJobRequest;
	queue: UploadEntryQueue;
	done: boolean;
	started: boolean;
}

const ports = new Set<MessagePort>();
const jobs: UploadJobSnapshot[] = [];
const streamingJobs = new Map<string, StreamingJob>();
let runningJobs = Promise.resolve();
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
			const id = createStreamingJob({ ...message.job, totalFiles: message.job.files.length }, message.job.files.length);
			post(port, { type: 'enqueued', jobId: id });
			for (let i = 0; i < message.job.files.length; i++) {
				pushEntry(id, legacyEntryToResolved(message.job.files[i], i));
			}
			finishEntries(id);
			return;
		}
		if (message.type === 'enqueue-streaming') {
			const id = createStreamingJob(message.job, message.job.totalFiles);
			post(port, { type: 'enqueued', jobId: id, requestId: message.requestId });
			return;
		}
		if (message.type === 'push-entry') {
			pushEntry(message.jobId, message.entry);
			return;
		}
		if (message.type === 'finish-entries') {
			finishEntries(message.jobId);
			return;
		}
		if (message.type === 'fail-entries') {
			failEntries(message.jobId, message.error);
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

function broadcastEncryptionKey(jobId: string, key: string): void {
	const message: UploadWorkerServerMessage = { type: 'encryption-key', jobId, key };
	for (const port of ports) port.postMessage(message);
}

function updateJob(id: string, patch: Partial<UploadJobSnapshot>): void {
	const job = jobs.find(j => j.id === id);
	if (!job) return;
	Object.assign(job, patch, { updatedAt: Date.now() });
	broadcast();
}

function createStreamingJob(request: UploadStreamingJobRequest, totalFiles: number): string {
	const id = crypto.randomUUID();
	const now = Date.now();
	const job: StreamingJob = {
		id,
		request,
		queue: new UploadEntryQueue(request.mode === 'tar' || request.mode === 'targz' ? 'index' : 'ready'),
		done: false,
		started: false,
	};
	streamingJobs.set(id, job);
	jobs.unshift({
		id,
		status: 'queued',
		bucketName: request.bucketName,
		prefix: request.prefix,
		mode: request.mode,
		filename: '',
		fileIndex: 0,
		totalFiles,
		uploadedBytes: 0,
		totalBytes: request.totalBytes,
		createdAt: now,
		updatedAt: now,
	});
	broadcast();
	startStreamingJob(job);
	return id;
}

function startStreamingJob(job: StreamingJob): void {
	if (job.started) return;
	job.started = true;
	runningJobs = runningJobs.then(async () => {
		updateJob(job.id, { status: 'running' });
		try {
			const result = await executeStreamingUpload(job.id, job.request, job.queue);
			updateJob(job.id, { status: 'done', uploadedBytes: result.totalBytes, totalBytes: result.totalBytes, completedPath: result.completedPath, fileIds: result.fileIds, uploadedFilePaths: result.uploadedFilePaths });
		} catch (err) {
			job.queue.close();
			console.error('Streaming upload job failed', err, { jobId: job.id });
			updateJob(job.id, { status: 'error', error: err instanceof Error ? err.message : String(err) });
		} finally {
			streamingJobs.delete(job.id);
			await job.queue.cleanupAll();
		}
	});
}

function pushEntry(jobId: string, entry: UploadResolvedEntry): void {
	const job = streamingJobs.get(jobId);
	if (!job) {
		void cleanupResolvedEntry(entry);
		return;
	}
	const current = jobs.find(item => item.id === jobId);
	if (current) {
		updateJob(jobId, { totalBytes: current.totalBytes + entry.size - entry.originalSize });
	}
	job.queue.push(entry);
}

function finishEntries(jobId: string): void {
	const job = streamingJobs.get(jobId);
	if (!job) return;
	job.done = true;
	job.queue.close();
}

function failEntries(jobId: string, error: string): void {
	const job = streamingJobs.get(jobId);
	if (!job) return;
	job.queue.fail(new Error(error));
}

function legacyEntryToResolved(entry: UploadWorkerEntry, index: number): UploadResolvedEntry {
	if (entry.source === 'opfs') {
		return {
			originalIndex: index,
			path: entry.path,
			name: basename(entry.path),
			parentPath: parentPath(entry.path),
			size: entry.size,
			originalSize: entry.size,
			type: entry.type,
			lastModified: entry.lastModified,
			source: { kind: 'opfs', opfsName: entry.opfsName },
		};
	}
	return {
		originalIndex: index,
		path: entry.path,
		name: basename(entry.path),
		parentPath: parentPath(entry.path),
		size: entry.file.size,
		originalSize: entry.file.size,
		type: entry.file.type,
		lastModified: entry.file.lastModified,
		source: { kind: 'file', file: entry.file },
	};
}

function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? path : path.slice(slash + 1);
}

function parentPath(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash + 1);
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

async function openUpload(path: string, request: UploadStreamingJobRequest): Promise<OpenUploadResult> {
	const result = await apiPost<{ fileId: string; partSize: number }>('/api/files/create/open', {
		bucketId: request.bucketId,
		path,
		partSize: request.partSize,
	}, request.authToken);
	return { fileId: result.fileId, partSize: result.partSize };
}

async function closeUpload(fileId: string, request: UploadStreamingJobRequest, mimeType?: string): Promise<void> {
	await apiPost('/api/files/create/close', {
		fileId,
		visibility: request.visibility,
		isListed: request.isListed,
		passphrase: request.passphrase || undefined,
		isDownloadCountEnabled: request.isDownloadCountEnabled ?? false,
		isDownloadCountVisible: request.isDownloadCountEnabled ? request.isDownloadCountVisible ?? false : false,
		mimeType,
		isEncrypted: request.isEncrypted ?? false,
	}, request.authToken);
}

async function deleteExistingFile(path: string, request: UploadStreamingJobRequest): Promise<void> {
	await apiPost('/api/files/delete', { bucketId: request.bucketId, path }, request.authToken);
}

async function tusUpload(fileId: string, blob: Blob, path: string, partSize: number, request: UploadStreamingJobRequest, onProgress: (uploaded: number) => void): Promise<void> {
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

async function nonResumeUpload(fileId: string, blob: Blob, path: string, request: UploadStreamingJobRequest, onProgress: (uploaded: number) => void): Promise<void> {
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

async function uploadResolvedBlob(entry: UploadResolvedEntry, blob: Blob, path: string, request: UploadStreamingJobRequest, onProgress: (uploaded: number) => void, mimeType?: string): Promise<string> {
	const { fileId, partSize } = await openUpload(path, request);
	try {
		const nonResumeUploadLimitBytes = request.nonResumeUploadLimitBytes ?? DEFAULT_NON_RESUME_UPLOAD_LIMIT_BYTES;
		if (blob.size < nonResumeUploadLimitBytes) {
			await nonResumeUpload(fileId, blob, path, request, onProgress);
		} else {
			await tusUpload(fileId, blob, path, partSize, request, onProgress);
		}
		if (entry.archive?.kind === 'tar') {
			await apiPost('/api/files/create/tar-index', { fileId, files: entry.archive.files }, request.authToken);
		}
		await closeUpload(fileId, request, mimeType ?? (entry.archive?.kind === 'tar' ? entry.type : undefined));
		return fileId;
	} catch (err) {
		await deleteExistingFile(path, request).catch(() => {});
		throw err;
	}
}

async function uploadStream(stream: ReadableStream<Uint8Array>, path: string, request: UploadStreamingJobRequest, onProgress: (uploaded: number) => void, mimeType?: string): Promise<string> {
	const fileId = await uploadChunkedStream(stream, path, request, onProgress);
	await closeUpload(fileId, request, mimeType);
	return fileId;
}

async function uploadArchiveStream(
	stream: ReadableStream<Uint8Array>,
	index: Promise<TarIndex[] | TarGzIndex[]>,
	archivePath: string,
	indexEndpoint: '/api/files/create/tar-index' | '/api/files/create/targz-index',
	request: UploadStreamingJobRequest,
	onProgress: (uploaded: number) => void,
	mimeType?: string,
): Promise<string> {
	const { fileId, partSize } = await openUpload(archivePath, request);
	try {
		await writeStreamParts(fileId, partSize, stream, archivePath, request, onProgress);
		await apiPost(indexEndpoint, { fileId, files: await index }, request.authToken);
		await closeUpload(fileId, request, mimeType);
		return fileId;
	} catch (err) {
		await deleteExistingFile(archivePath, request).catch(() => {});
		throw err;
	}
}

async function uploadChunkedStream(
	stream: ReadableStream<Uint8Array>,
	path: string,
	request: UploadStreamingJobRequest,
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
	stream: ReadableStream<Uint8Array>,
	path: string,
	request: UploadStreamingJobRequest,
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
		private readonly request: UploadStreamingJobRequest,
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

class UploadEntryQueue {
	private readonly ready: UploadResolvedEntry[] = [];
	private readonly byIndex = new Map<number, UploadResolvedEntry>();
	private readonly waiters: Array<{
		resolve: (entry: UploadResolvedEntry | null) => void;
		reject: (reason?: unknown) => void;
	}> = [];
	private closed = false;
	private error: unknown = null;
	private nextIndex = 0;
	private readonly cleanupEntries = new Set<UploadResolvedEntry>();

	constructor(private readonly mode: 'ready' | 'index') {}

	push(entry: UploadResolvedEntry): void {
		this.cleanupEntries.add(entry);
		if (this.closed || this.error) {
			void cleanupResolvedEntry(entry);
			return;
		}
		if (this.mode === 'ready') {
			this.ready.push(entry);
		} else {
			this.byIndex.set(entry.originalIndex, entry);
		}
		this.flush();
	}

	close(): void {
		this.closed = true;
		this.flush();
	}

	fail(error: unknown): void {
		this.error = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	async next(): Promise<UploadResolvedEntry | null> {
		if (this.error) throw this.error;
		const entry = this.shiftReadyEntry();
		if (entry) return entry;
		if (this.closed) return null;
		return await new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	markConsumed(entry: UploadResolvedEntry): void {
		this.cleanupEntries.delete(entry);
	}

	async cleanupAll(): Promise<void> {
		await Promise.all(Array.from(this.cleanupEntries, cleanupResolvedEntry));
		this.cleanupEntries.clear();
	}

	private flush(): void {
		while (this.waiters.length > 0) {
			if (this.error) {
				this.waiters.shift()?.reject(this.error);
				continue;
			}
			const entry = this.shiftReadyEntry();
			if (entry) {
				this.waiters.shift()?.resolve(entry);
				continue;
			}
			if (this.closed) {
				this.waiters.shift()?.resolve(null);
				continue;
			}
			break;
		}
	}

	private shiftReadyEntry(): UploadResolvedEntry | null {
		if (this.mode === 'ready') return this.ready.shift() ?? null;
		const entry = this.byIndex.get(this.nextIndex);
		if (!entry) return null;
		this.byIndex.delete(this.nextIndex++);
		return entry;
	}
}

async function executeStreamingUpload(id: string, request: UploadStreamingJobRequest, queue: UploadEntryQueue): Promise<{ completedPath: string; totalBytes: number; fileIds: string[]; uploadedFilePaths: string[] }> {
	let cumulativeBytes = 0;
	let totalBytes = request.totalBytes;
	let completedPath = '';
	const fileIds: string[] = [];
	const uploadedFilePaths: string[] = [];

	// Set up encryption if requested
	let cryptoKey: CryptoKey | null = null;
	if (request.isEncrypted) {
		const rawKey = generateRawKey();
		cryptoKey = await importAesCtrKey(rawKey, ['encrypt']);
		broadcastEncryptionKey(id, keyToMultibase(rawKey));
	}

	if (request.mode === 'individual' || request.mode === 'gz') {
		let processedFiles = 0;
		while (true) {
			const entry = await queue.next();
			if (!entry) break;
			updateJob(id, { filename: entry.path, fileIndex: processedFiles, uploadedBytes: cumulativeBytes, totalBytes });
			const file = await readResolvedEntryFile(entry);
			const isTarArchiveEntry = entry.archive?.kind === 'tar';
			const path = request.mode === 'gz' && !isTarArchiveEntry ? `${request.prefix}${entry.path}.gz` : `${request.prefix}${entry.path}`;
			const originalMimeType = entry.type || file.type || undefined;

			if (request.mode === 'gz' && !isTarArchiveEntry) {
				let stream: ReadableStream<Uint8Array> = file.stream().pipeThrough(new CompressionStream('gzip'));
				if (cryptoKey) {
					stream = stream.pipeThrough(createAesCtrEncryptTransform(cryptoKey, generateIv()));
				}
				const fileId = await uploadStream(stream, path, request, (n) => {
					updateJob(id, { uploadedBytes: cumulativeBytes + n });
				}, cryptoKey ? originalMimeType : undefined);
				fileIds.push(fileId);
				uploadedFilePaths.push(path);
			} else if (cryptoKey) {
				// Encrypted individual file: stream through encrypt transform
				const iv = generateIv();
				const encryptedStream = file.stream().pipeThrough(createAesCtrEncryptTransform(cryptoKey, iv));
				const fileId = await uploadStream(encryptedStream, path, request, (n) => {
					updateJob(id, { uploadedBytes: cumulativeBytes + n });
				}, originalMimeType);
				fileIds.push(fileId);
				uploadedFilePaths.push(path);
			} else {
				const fileId = await uploadResolvedBlob(entry, file, path, request, (n) => {
					updateJob(id, { uploadedBytes: cumulativeBytes + n });
				});
				fileIds.push(fileId);
				uploadedFilePaths.push(path);
			}
			cumulativeBytes += file.size;
			processedFiles++;
			completedPath = path;
			queue.markConsumed(entry);
			await cleanupResolvedEntry(entry);
			updateJob(id, { fileIndex: processedFiles, uploadedBytes: cumulativeBytes });
		}
			return { completedPath, totalBytes: currentJobTotalBytes(id, totalBytes), fileIds, uploadedFilePaths };
	}

	updateJob(id, { filename: '', fileIndex: 0, totalFiles: request.totalFiles, uploadedBytes: 0 });
	const archiveEntries = cryptoKey
		? encryptedEntriesAsFileEntries(queue, cryptoKey)
		: resolvedEntriesAsFileEntries(queue);
	if (request.mode === 'tar') {
		const archivePath = `${request.prefix}${request.archiveBaseName}.tar`;
		const archive = await createTarArchive(archiveEntries, (p: ArchiveProgress) => {
			updateJob(id, { filename: p.currentFile, fileIndex: p.processedFiles, totalFiles: p.totalFiles });
		});
		const archiveFileId = await uploadArchiveStream(archive.stream, archive.index, archivePath, '/api/files/create/tar-index', request, (n) => {
			updateJob(id, { uploadedBytes: n });
		}, cryptoKey ? 'application/x-tar' : undefined);
		fileIds.push(archiveFileId);
		uploadedFilePaths.push(archivePath);
			return { completedPath: archivePath, totalBytes: currentJobTotalBytes(id, totalBytes), fileIds, uploadedFilePaths };
	}

	const archivePath = `${request.prefix}${request.archiveBaseName}.tar.gz`;
	const archiver = await BgzfTarArchiver.createFromEntries(archiveEntries, (p: ArchiveProgress) => {
		updateJob(id, { filename: p.currentFile, fileIndex: p.processedFiles, totalFiles: p.totalFiles });
	});
	const archiveFileId = await uploadArchiveStream(archiver.stream, archiver.index, archivePath, '/api/files/create/targz-index', request, (n) => {
		updateJob(id, { uploadedBytes: n });
	}, cryptoKey ? 'application/gzip' : undefined);
	fileIds.push(archiveFileId);
	uploadedFilePaths.push(archivePath);
	return { completedPath: archivePath, totalBytes: currentJobTotalBytes(id, totalBytes), fileIds, uploadedFilePaths };
}

function currentJobTotalBytes(id: string, fallback: number): number {
	return jobs.find(job => job.id === id)?.totalBytes ?? fallback;
}

async function* resolvedEntriesAsFileEntries(queue: UploadEntryQueue): AsyncGenerator<FileEntry> {
	while (true) {
		const entry = await queue.next();
		if (!entry) break;
		try {
			yield {
				path: entry.path,
				file: await readResolvedEntryFile(entry),
			};
		} finally {
			queue.markConsumed(entry);
			await cleanupResolvedEntry(entry);
		}
	}
}

async function* encryptedEntriesAsFileEntries(queue: UploadEntryQueue, key: CryptoKey): AsyncGenerator<FileEntry> {
	while (true) {
		const entry = await queue.next();
		if (!entry) break;
		try {
			const file = await readResolvedEntryFile(entry);
			// Detect MIME type from the plaintext file before encryption
			const originalMimeType = await detectMimeType(entry.path, file);
			const iv = generateIv();
			// Stream through the encrypt transform to avoid holding both plaintext
			// and ciphertext in memory simultaneously (important for large files).
			const encryptedStream = file.stream().pipeThrough(createAesCtrEncryptTransform(key, iv));
			const encryptedBlob = await new Response(encryptedStream).blob();
			yield {
				path: entry.path,
				file: new File([encryptedBlob], entry.path, { type: 'application/octet-stream', lastModified: file.lastModified }),
				mimeType: originalMimeType,
			};
		} finally {
			queue.markConsumed(entry);
			await cleanupResolvedEntry(entry);
		}
	}
}

async function readResolvedEntryFile(entry: UploadResolvedEntry): Promise<File> {
	if (entry.source.kind === 'opfs') {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(entry.source.opfsName);
		const file = await handle.getFile();
		return new File([file], entry.path, { type: entry.type || file.type, lastModified: entry.lastModified || file.lastModified });
	}
	return entry.source.file;
}

async function cleanupResolvedEntry(entry: UploadResolvedEntry): Promise<void> {
	if (entry.source.kind !== 'opfs') return;
	await deleteFromOpfs(entry.source.opfsName);
}

async function deleteFromOpfs(name: string): Promise<void> {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(name).catch(() => {});
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
