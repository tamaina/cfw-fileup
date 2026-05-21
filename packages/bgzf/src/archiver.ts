import { createBgzfBlock } from './bgzf';
import { createTarHeader } from './tar';
import type { ArchiveProgress, FileEntry, TarGzIndex, TarIndex } from './types';

async function readFirstBytes(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (total < maxBytes) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		const needed = maxBytes - total;
		if (value.byteLength <= needed) {
			chunks.push(value);
			total += value.byteLength;
		} else {
			chunks.push(value.slice(0, needed));
			total = maxBytes;
			break;
		}
	}
	await reader.cancel();
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function makePullStream<T>(
	gen: AsyncGenerator<T>,
	onError?: (err: unknown) => void,
): ReadableStream<T> {
	return new ReadableStream<T>({
		async pull(controller) {
			try {
				const { value, done } = await gen.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (err) {
				onError?.(err);
				controller.error(err);
			}
		},
		cancel() {
			gen.return(undefined as unknown as T);
			onError?.(new Error('Stream cancelled'));
		},
	});
}

interface PreparedEntry {
	path: string;
	file: File;
	mimeType: string;
	mtime: number;
}

class TarArchiverBase<TIdx> {
	readonly stream: ReadableStream<Uint8Array>;
	readonly index: Promise<TIdx[]>;

	protected constructor(stream: ReadableStream<Uint8Array>, index: Promise<TIdx[]>) {
		this.stream = stream;
		this.index = index;
	}

	static async* walkDirectory(dir: FileSystemDirectoryHandle, prefix = ''): AsyncGenerator<FileEntry> {
		for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
			if (handle.kind === 'file') {
				yield { path: prefix + name, file: await (handle as FileSystemFileHandle).getFile() };
			} else {
				yield* TarArchiverBase.walkDirectory(handle as FileSystemDirectoryHandle, prefix + name + '/');
			}
		}
	}

	protected static async prepareEntries(entries: Iterable<FileEntry> | AsyncIterable<FileEntry>): Promise<PreparedEntry[]> {
		const now = Date.now();
		const walked: FileEntry[] = [];
		for await (const entry of entries) walked.push(entry);
		const { filetypemime } = await import('magic-bytes.js');
		return Promise.all(walked.map(async ({ path, file }) => {
			const bytes = await readFirstBytes(file.stream(), 4100);
			const mimes = filetypemime(bytes);
			return {
				path,
				file,
				mimeType: mimes[0] ?? (file.type || 'application/octet-stream'),
				mtime: file.lastModified || now,
			};
		}));
	}
}

export class TarArchiver extends TarArchiverBase<TarIndex> {
	static async create(dir: FileSystemDirectoryHandle, onProgress?: (p: ArchiveProgress) => void): Promise<TarArchiver> {
		return TarArchiver.createFromEntries(TarArchiver.walkDirectory(dir), onProgress);
	}

	static async createFromEntries(fileEntries: Iterable<FileEntry> | AsyncIterable<FileEntry>, onProgress?: (p: ArchiveProgress) => void): Promise<TarArchiver> {
		const entries = await TarArchiverBase.prepareEntries(fileEntries);
		const totalFiles = entries.length;
		const totalBytes = entries.reduce((s, e) => s + e.file.size, 0);
		let resolveIndex!: (v: TarIndex[]) => void;
		let rejectIndex!: (e: unknown) => void;
		const index = new Promise<TarIndex[]>((res, rej) => { resolveIndex = res; rejectIndex = rej; });

		const gen = (async function* () {
			const tarEntries: TarIndex[] = [];
			let offset = 0;
			let processedBytes = 0;
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				onProgress?.({ processedFiles: i, totalFiles, currentFile: entry.path, processedBytes, totalBytes });
				const padLen = (512 - (entry.file.size % 512)) % 512;
				yield createTarHeader(entry.path, entry.file.size, entry.mtime);
				offset += 512;
				const dataOffset = offset;
				const reader = entry.file.stream().getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						yield value;
						offset += value.length;
					}
				} finally {
					reader.releaseLock();
				}
				if (padLen > 0) {
					yield new Uint8Array(padLen);
					offset += padLen;
				}
				processedBytes += entry.file.size;
				tarEntries.push({ path: entry.path, mimeType: entry.mimeType, offset: dataOffset, size: entry.file.size });
				onProgress?.({ processedFiles: i + 1, totalFiles, currentFile: entry.path, processedBytes, totalBytes });
			}
			yield new Uint8Array(1024);
			resolveIndex(tarEntries);
		})();

		return new TarArchiver(makePullStream(gen, rejectIndex), index);
	}
}

const BGZF_BLOCK_SIZE = 65000;

export class BgzfTarArchiver extends TarArchiverBase<TarGzIndex> {
	static async create(dir: FileSystemDirectoryHandle, onProgress?: (p: ArchiveProgress) => void): Promise<BgzfTarArchiver> {
		return BgzfTarArchiver.createFromEntries(BgzfTarArchiver.walkDirectory(dir), onProgress);
	}

	static async createFromEntries(fileEntries: Iterable<FileEntry> | AsyncIterable<FileEntry>, onProgress?: (p: ArchiveProgress) => void): Promise<BgzfTarArchiver> {
		const entries = await TarArchiverBase.prepareEntries(fileEntries);
		const totalFiles = entries.length;
		const totalBytes = entries.reduce((s, e) => s + e.file.size, 0);
		let resolveIndex!: (v: TarGzIndex[]) => void;
		let rejectIndex!: (e: unknown) => void;
		const index = new Promise<TarGzIndex[]>((res, rej) => { resolveIndex = res; rejectIndex = rej; });

		const gen = (async function* () {
			const blockOffsets: number[] = [];
			const blockLengths: number[] = [];
			let compressedOffset = 0;
			let totalWritten = 0;
			const blockBuffer = new Uint8Array(BGZF_BLOCK_SIZE);
			let bufLen = 0;
			const fileBounds: { path: string; mimeType: string; start: number; end: number }[] = [];

			async function* writeBytes(data: Uint8Array): AsyncGenerator<Uint8Array> {
				let pos = 0;
				while (pos < data.length) {
					const n = Math.min(BGZF_BLOCK_SIZE - bufLen, data.length - pos);
					blockBuffer.set(data.subarray(pos, pos + n), bufLen);
					bufLen += n;
					totalWritten += n;
					pos += n;
					if (bufLen === BGZF_BLOCK_SIZE) {
						const block = await createBgzfBlock(blockBuffer.slice(0, bufLen));
						blockOffsets.push(compressedOffset);
						blockLengths.push(block.length);
						compressedOffset += block.length;
						bufLen = 0;
						yield block;
					}
				}
			}

			let processedBytes = 0;
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				onProgress?.({ processedFiles: i, totalFiles, currentFile: entry.path, processedBytes, totalBytes });
				const padLen = (512 - (entry.file.size % 512)) % 512;
				yield* writeBytes(createTarHeader(entry.path, entry.file.size, entry.mtime));
				const dataStart = totalWritten;
				const reader = entry.file.stream().getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						yield* writeBytes(value);
					}
				} finally {
					reader.releaseLock();
				}
				if (padLen > 0) yield* writeBytes(new Uint8Array(padLen));
				fileBounds.push({ path: entry.path, mimeType: entry.mimeType, start: dataStart, end: dataStart + entry.file.size });
				processedBytes += entry.file.size;
				onProgress?.({ processedFiles: i + 1, totalFiles, currentFile: entry.path, processedBytes, totalBytes });
			}
			yield* writeBytes(new Uint8Array(1024));

			if (bufLen > 0) {
				const block = await createBgzfBlock(blockBuffer.slice(0, bufLen));
				blockOffsets.push(compressedOffset);
				blockLengths.push(block.length);
				compressedOffset += block.length;
				bufLen = 0;
				yield block;
			}

			const eofBlock = await createBgzfBlock(new Uint8Array(0));
			blockOffsets.push(compressedOffset);
			blockLengths.push(eofBlock.length);
			yield eofBlock;

			const totalUncompressed = totalWritten;
			resolveIndex(fileBounds.map((fb) => {
				const si = Math.floor(fb.start / BGZF_BLOCK_SIZE);
				const ei = Math.floor(Math.max(fb.end - 1, fb.start) / BGZF_BLOCK_SIZE);
				return {
					path: fb.path,
					mimeType: fb.mimeType,
					aStart: blockOffsets[si],
					aFirstEnd: blockOffsets[si] + blockLengths[si],
					aFinalStart: blockOffsets[ei],
					aEnd: blockOffsets[ei] + blockLengths[ei],
					rStartOffset: fb.start - si * BGZF_BLOCK_SIZE,
					rEndOffset: Math.min((ei + 1) * BGZF_BLOCK_SIZE, totalUncompressed) - fb.end,
				};
			}));
		})();

		return new BgzfTarArchiver(makePullStream(gen, rejectIndex), index);
	}
}

