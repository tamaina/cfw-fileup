import { createTarHeader, parseTarStream, createBgzfDecompressor, isBgzf, TarArchiver, type FileEntry } from 'bgzf';
import { ZipWriter } from '@zip.js/zip.js';
import { createOpfsTempFile } from './opfs-temp';
import { createAesCtrDecryptTransform, importAesCtrKey, multibaseToKey } from '../../shared/encryption';

type ArchiveFormat = 'tar' | 'zip';

type FileListEntry = {
	type: 'dir' | 'file';
	name: string;
	path?: string;
	fileId?: string;
	size?: number;
	isTargz?: boolean;
	isTar?: boolean;
};

type DirectoryTarget =
	| { type: 'file'; path: string; fileId: string; size: number }
	| { type: 'directory'; path: string };

type ArchiveDownloadWorkerDirectoryRequest = {
	readonly id: string;
	readonly mode: 'directory';
	readonly format: ArchiveFormat;
	readonly bucketName: string;
	readonly basePath: string;
	readonly targets: DirectoryTarget[];
	readonly excludePaths: string[];
	readonly authHeaders: Record<string, string>;
	readonly filename: string;
	/** 指定すると OPFS の代わりにこのハンドルへ直接書き込む（構造化複製で渡される） */
	readonly fileHandle?: FileSystemFileHandle;
};

type ArchiveDownloadWorkerToZipRequest = {
	readonly id: string;
	readonly mode: 'archive-to-zip';
	readonly fileId: string;
	readonly token?: string;
	readonly isTargz: boolean;
	readonly filename: string;
	/** 指定すると tar 内の各エントリーを復号してから zip に格納する */
	readonly encryptionKey?: string;
	readonly authHeaders: Record<string, string>;
	/** 指定すると OPFS の代わりにこのハンドルへ直接書き込む（構造化複製で渡される） */
	readonly fileHandle?: FileSystemFileHandle;
};

type ArchiveDownloadWorkerDecryptRequest = {
	readonly id: string;
	readonly mode: 'archive-decrypt';
	readonly fileId: string;
	readonly token?: string;
	readonly isTargz: boolean;
	/** true の場合、復号後に gzip 圧縮せず tar のまま出力する */
	readonly decompress?: boolean;
	readonly filename: string;
	/** 復号キー（multibase形式）。tar 内はエントリー単位で暗号化されている */
	readonly encryptionKey: string;
	readonly authHeaders: Record<string, string>;
	/** 指定すると OPFS の代わりにこのハンドルへ直接書き込む（構造化複製で渡される） */
	readonly fileHandle?: FileSystemFileHandle;
};

export type ArchiveDownloadWorkerRequest = ArchiveDownloadWorkerDirectoryRequest | ArchiveDownloadWorkerToZipRequest | ArchiveDownloadWorkerDecryptRequest;

export type ArchiveDownloadProgress = {
	phase: 'resolving' | 'reading' | 'writing' | 'done';
	processedFiles: number;
	totalFiles: number;
	currentFile: string;
	completedBytes?: number;
	totalBytes?: number;
};

export type ArchiveDownloadWorkerMessage =
	| { type: 'progress'; id: string; progress: ArchiveDownloadProgress }
	| { type: 'done'; id: string; opfsName?: string; savedDirectly: boolean; filename: string; mimeType: string }
	| { type: 'error'; id: string; error: string; opfsName?: string };

const TAR_MIME = 'application/x-tar';
const ZIP_MIME = 'application/zip';

self.onmessage = (event: MessageEvent<ArchiveDownloadWorkerRequest>) => {
	void handleRequest(event.data);
};

async function handleRequest(request: ArchiveDownloadWorkerRequest): Promise<void> {
	let opfsName: string | undefined;
	try {
		const savedDirectly = request.fileHandle != null;
		let fileHandle: FileSystemFileHandle;
		if (request.fileHandle) {
			fileHandle = request.fileHandle;
		} else {
			const tempFile = await createOpfsTempFile(request.id, opfsExtension(request));
			opfsName = tempFile.opfsName;
			fileHandle = tempFile.fileHandle;
		}

		if (request.mode === 'directory') {
			const files = await resolveDirectoryTargets(request);
			if (request.format === 'tar') {
				await writeTar(fileHandle, files, request);
				post({ type: 'done', id: request.id, opfsName, savedDirectly, filename: request.filename, mimeType: TAR_MIME });
			} else {
				await writeZip(fileHandle, files, request);
				post({ type: 'done', id: request.id, opfsName, savedDirectly, filename: request.filename, mimeType: ZIP_MIME });
			}
			return;
		}

		if (request.mode === 'archive-to-zip') {
			await writeArchiveAsZip(fileHandle, request);
			post({ type: 'done', id: request.id, opfsName, savedDirectly, filename: request.filename, mimeType: ZIP_MIME });
			return;
		}

		if (request.mode === 'archive-decrypt') {
			const outputGzip = request.isTargz && !request.decompress;
			const mimeType = outputGzip ? 'application/gzip' : TAR_MIME;
			await writeDecryptedArchive(fileHandle, request);
			post({ type: 'done', id: request.id, opfsName, savedDirectly, filename: request.filename, mimeType });
			return;
		}
	} catch (err) {
		console.error('Archive download worker failed', err, {
			mode: request.mode,
			filename: request.filename,
			opfsName,
		});
		post({ type: 'error', id: request.id, error: err instanceof Error ? err.message : String(err), opfsName });
	}
}

function opfsExtension(request: ArchiveDownloadWorkerRequest): string {
	if (request.mode === 'directory') return request.format === 'tar' ? '.tar' : '.zip';
	if (request.mode === 'archive-decrypt') return (request.isTargz && !request.decompress) ? '.tar.gz' : '.tar';
	return '.zip';
}

function post(message: ArchiveDownloadWorkerMessage): void {
	self.postMessage(message);
}

function progress(id: string, progress: ArchiveDownloadProgress): void {
	post({ type: 'progress', id, progress });
}

async function listDirectory(bucketName: string, path: string, headers: Record<string, string>): Promise<FileListEntry[]> {
	const hasAuth = Object.keys(headers).length > 0;
	const entries: FileListEntry[] = [];
	let cursor: string | null = null;
	do {
		const res = hasAuth
			? await fetch('/api/files/ls', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ bucketName, path, cursor }),
			})
			: await fetch(`/api/files/ls?bucketName=${encodeURIComponent(bucketName)}&path=${encodeURIComponent(path)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
		if (!res.ok) throw new Error(`Failed to list ${path || '/'}: HTTP ${res.status}`);
		const data = await res.json() as { items: FileListEntry[]; nextCursor: string | null };
		entries.push(...data.items);
		cursor = data.nextCursor;
	} while (cursor);
	return entries;
}

async function resolveDirectoryTargets(request: Extract<ArchiveDownloadWorkerRequest, { mode: 'directory' }>): Promise<Array<{ path: string; fileId: string; size: number }>> {
	progress(request.id, { phase: 'resolving', processedFiles: 0, totalFiles: 0, currentFile: '' });
	const excludes = new Set(request.excludePaths);
	const files: Array<{ path: string; fileId: string; size: number }> = [];

	async function walk(path: string): Promise<void> {
		const entries = await listDirectory(request.bucketName, path, request.authHeaders);
		for (const entry of entries) {
			const fullPath = entry.path ?? `${path}${entry.name}${entry.type === 'dir' ? '/' : ''}`;
			if (excludes.has(fullPath)) continue;
			if (entry.type === 'dir') {
				await walk(fullPath.endsWith('/') ? fullPath : `${fullPath}/`);
			} else if (entry.fileId) {
				files.push({ path: fullPath, fileId: entry.fileId, size: entry.size ?? 0 });
			}
		}
	}

	for (const target of request.targets) {
		if (excludes.has(target.path)) continue;
		if (target.type === 'file') {
			files.push({ path: target.path, fileId: target.fileId, size: target.size });
		} else {
			await walk(target.path);
		}
	}
	return files;
}

function archiveEntryName(path: string, basePath: string): string {
	const name = path.startsWith(basePath) ? path.slice(basePath.length) : path;
	return name.replace(/^\/+/, '') || path.split('/').filter(Boolean).at(-1) || 'file';
}

function downloadFileUrl(fileId: string): string {
	return `/d/${encodeURIComponent(fileId)}`;
}

async function fetchFile(fileId: string, headers: Record<string, string>): Promise<Response> {
	const res = await fetch(downloadFileUrl(fileId), { headers });
	if (!res.ok || !res.body) throw new Error(`Failed to fetch file ${fileId}: HTTP ${res.status}`);
	return res;
}

async function pipeToWritable(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	writable: FileSystemWritableFileStream,
	onChunk?: (bytes: number) => void,
): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await writable.write(value);
			onChunk?.(value.byteLength);
		}
	} finally {
		reader.releaseLock();
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

async function writeTar(
	fileHandle: FileSystemFileHandle,
	files: Array<{ path: string; fileId: string; size: number }>,
	request: Extract<ArchiveDownloadWorkerRequest, { mode: 'directory' }>,
): Promise<void> {
	const writable = await fileHandle.createWritable();
	let processedFiles = 0;
	let completedBytes = 0;
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	try {
		for (const file of files) {
			const name = archiveEntryName(file.path, request.basePath);
			progress(request.id, { phase: 'reading', processedFiles, totalFiles: files.length, currentFile: name, completedBytes, totalBytes });
			const res = await fetchFile(file.fileId, request.authHeaders);
			const size = Number(res.headers.get('Content-Length')) || file.size;
			const progressSize = file.size || size;
			progress(request.id, { phase: 'writing', processedFiles, totalFiles: files.length, currentFile: name, completedBytes, totalBytes });
			await writable.write(createTarHeader(name, size, Date.now()));
			let fileBytes = 0;
			await pipeToWritable(res.body!, writable, (bytes) => {
				fileBytes += bytes;
				progress(request.id, { phase: 'writing', processedFiles, totalFiles: files.length, currentFile: name, completedBytes: completedBytes + Math.min(fileBytes, progressSize), totalBytes });
			});
			const padding = (512 - (size % 512)) % 512;
			if (padding > 0) await writable.write(new Uint8Array(padding));
			completedBytes += progressSize;
			processedFiles++;
			progress(request.id, { phase: 'writing', processedFiles, totalFiles: files.length, currentFile: name, completedBytes, totalBytes });
		}
		await writable.write(new Uint8Array(1024));
		await writable.close();
		progress(request.id, { phase: 'done', processedFiles, totalFiles: files.length, currentFile: '', completedBytes: totalBytes, totalBytes });
	} catch (err) {
		await writable.abort().catch(() => {});
		throw err;
	}
}

async function writeZip(
	fileHandle: FileSystemFileHandle,
	files: Array<{ path: string; fileId: string; size: number }>,
	request: Extract<ArchiveDownloadWorkerRequest, { mode: 'directory' }>,
): Promise<void> {
	const writable = await fileHandle.createWritable();
	const zipWriter = new ZipWriter(writable, { bufferedWrite: false });
	let processedFiles = 0;
	let completedBytes = 0;
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	try {
		for (const file of files) {
			const name = archiveEntryName(file.path, request.basePath);
			progress(request.id, { phase: 'reading', processedFiles, totalFiles: files.length, currentFile: name, completedBytes, totalBytes });
			const res = await fetchFile(file.fileId, request.authHeaders);
			const size = Number(res.headers.get('Content-Length')) || file.size;
			const progressSize = file.size || size;
			progress(request.id, { phase: 'writing', processedFiles, totalFiles: files.length, currentFile: name, completedBytes, totalBytes });
			let fileBytes = 0;
			await zipWriter.add(name, withByteProgress(res.body!, (bytes) => {
				fileBytes += bytes;
				progress(request.id, { phase: 'writing', processedFiles, totalFiles: files.length, currentFile: name, completedBytes: completedBytes + Math.min(fileBytes, progressSize), totalBytes });
			}));
			completedBytes += progressSize;
			processedFiles++;
			progress(request.id, { phase: 'writing', processedFiles, totalFiles: files.length, currentFile: name, completedBytes, totalBytes });
		}
		await zipWriter.close();
		progress(request.id, { phase: 'done', processedFiles, totalFiles: files.length, currentFile: '', completedBytes: totalBytes, totalBytes });
	} catch (err) {
		await zipWriter.close().catch(() => {});
		await writable.abort().catch(() => {});
		throw err;
	}
}

function archiveDownloadUrl(request: { fileId: string; token?: string }): string {
	const base = `/d/${encodeURIComponent(request.fileId)}`;
	return request.token ? `${base}?token=${encodeURIComponent(request.token)}` : base;
}

async function writeArchiveAsZip(fileHandle: FileSystemFileHandle, request: Extract<ArchiveDownloadWorkerRequest, { mode: 'archive-to-zip' }>): Promise<void> {
	const writable = await fileHandle.createWritable();
	const zipWriter = new ZipWriter(writable, { bufferedWrite: false });
	let processedFiles = 0;
	let cryptoKey: CryptoKey | null = null;
	if (request.encryptionKey) {
		const rawKey = multibaseToKey(request.encryptionKey);
		if (!rawKey) throw new Error('Invalid encryption key');
		cryptoKey = await importAesCtrKey(rawKey, ['decrypt']);
	}
	try {
		progress(request.id, { phase: 'reading', processedFiles: 0, totalFiles: 0, currentFile: request.filename });
		const res = await fetch(archiveDownloadUrl(request), { headers: request.authHeaders });
		if (!res.ok || !res.body) throw new Error(`Failed to fetch archive: HTTP ${res.status}`);
		const tarStream = request.isTargz
			? await createTarStreamFromGzip(res.body)
			: res.body;
		for await (const entry of parseTarStream(tarStream)) {
			progress(request.id, { phase: 'writing', processedFiles, totalFiles: 0, currentFile: entry.name });
			const body = cryptoKey
				? entry.stream.pipeThrough(createAesCtrDecryptTransform(cryptoKey))
				: entry.stream;
			await zipWriter.add(entry.name, body);
			processedFiles++;
			progress(request.id, { phase: 'writing', processedFiles, totalFiles: 0, currentFile: entry.name });
		}
		await zipWriter.close();
		progress(request.id, { phase: 'done', processedFiles, totalFiles: processedFiles, currentFile: '' });
	} catch (err) {
		await zipWriter.close().catch(() => {});
		await writable.abort().catch(() => {});
		throw err;
	}
}

/** tar 内の各エントリーを復号して、新しい tar / tar.gz アーカイブとして書き出す。
 *  tar.gz は BGZF ではなく標準 gzip で出力する（bsdtar 互換性のため）。 */
async function writeDecryptedArchive(fileHandle: FileSystemFileHandle, request: Extract<ArchiveDownloadWorkerRequest, { mode: 'archive-decrypt' }>): Promise<void> {
	const rawKey = multibaseToKey(request.encryptionKey);
	if (!rawKey) throw new Error('Invalid encryption key');
	const cryptoKey = await importAesCtrKey(rawKey, ['decrypt']);

	const res = await fetch(archiveDownloadUrl(request), { headers: request.authHeaders });
	if (!res.ok || !res.body) throw new Error(`Failed to fetch archive: HTTP ${res.status}`);
	const tarStream = request.isTargz
		? await createTarStreamFromGzip(res.body)
		: res.body;

	let processedFiles = 0;
	const entries = (async function* (): AsyncGenerator<FileEntry> {
		for await (const entry of parseTarStream(tarStream)) {
			progress(request.id, { phase: 'reading', processedFiles, totalFiles: 0, currentFile: entry.name });
			const decryptedStream = entry.stream.pipeThrough(createAesCtrDecryptTransform(cryptoKey));
			const blob = await new Response(decryptedStream).blob();
			processedFiles++;
			progress(request.id, { phase: 'writing', processedFiles, totalFiles: 0, currentFile: entry.name });
			yield { path: entry.name, file: new File([blob], entry.name, { type: 'application/octet-stream' }) };
		}
	})();

	const writable = await fileHandle.createWritable();
	try {
		const archiver = await TarArchiver.createFromEntries(entries);
		const outputGzip = request.isTargz && !request.decompress;
		const stream: ReadableStream<Uint8Array<ArrayBuffer>> = outputGzip
			? archiver.stream.pipeThrough(new CompressionStream('gzip'))
			: archiver.stream;
		await pipeToWritable(stream, writable);
		await writable.close();
		progress(request.id, { phase: 'done', processedFiles, totalFiles: processedFiles, currentFile: '' });
	} catch (err) {
		await writable.abort().catch(() => {});
		throw err;
	}
}

async function createTarStreamFromGzip(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
	const { rebuilt, bgzf } = await peekArchiveStream(stream);
	return bgzf
		? rebuilt.pipeThrough(createBgzfDecompressor())
		: rebuilt.pipeThrough(new DecompressionStream('gzip'));
}

async function peekArchiveStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<{
	readonly rebuilt: ReadableStream<Uint8Array<ArrayBuffer>>;
	readonly gzip: boolean;
	readonly bgzf: boolean;
}> {
	const reader = stream.getReader();
	const first = await reader.read();
	reader.releaseLock();
	if (first.done || !first.value) throw new Error('Archive is empty');
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
