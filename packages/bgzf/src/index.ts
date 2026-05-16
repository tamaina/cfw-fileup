// ---- BGZF detection ----

/** Check BGZF magic: FLG=FEXTRA (0x04), BC subfield (0x42, 0x43) */
export function isBgzf(bytes: Uint8Array): boolean {
	return bytes.length >= 18
		&& bytes[0] === 0x1f && bytes[1] === 0x8b
		&& bytes[3] === 0x04
		&& bytes[12] === 0x42 && bytes[13] === 0x43;
}

// ---- BGZF decompression ----

async function decompressDeflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const ds = new DecompressionStream('deflate-raw');
	const chunks: Uint8Array[] = [];

	const writePromise = (async () => {
		const writer = ds.writable.getWriter();
		await writer.write(data);
		await writer.close();
	})();

	const readPromise = (async () => {
		const reader = ds.readable.getReader();
		try {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	})();

	await Promise.all([writePromise, readPromise]);

	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) { out.set(c, offset); offset += c.length; }
	return out;
}

export function createBgzfDecompressor(): TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
	let buf = new Uint8Array(0);
	return new TransformStream({
		async transform(chunk, controller) {
			const merged = new Uint8Array(buf.length + chunk.length);
			merged.set(buf);
			merged.set(chunk, buf.length);
			buf = merged;

			while (buf.length >= 18) {
				const blockSize = (buf[16] | (buf[17] << 8)) + 1;
				if (buf.length < blockSize) break;

				const deflateData = buf.slice(18, blockSize - 8);
				const isize = buf[blockSize - 4]
					| (buf[blockSize - 3] << 8)
					| (buf[blockSize - 2] << 16)
					| (buf[blockSize - 1] << 24);
				buf = buf.slice(blockSize);

				if (isize === 0) return; // EOF marker block

				controller.enqueue(await decompressDeflateRaw(deflateData as Uint8Array<ArrayBuffer>));
			}
		},
	});
}

// ---- CRC-32 ----

function calculateCrc32(data: Uint8Array): number {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

// ---- Raw deflate compression ----

async function compressDeflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	// 'deflate-raw' = RFC 1951 raw deflate, required by BGZF (gzip CDATA)
	// Write and read must run concurrently: TransformStream backpressure causes
	// writer.write/close to stall if the readable side is not being drained.
	const cs = new CompressionStream('deflate-raw');
	const chunks: Uint8Array[] = [];

	const writePromise = (async () => {
		const writer = cs.writable.getWriter();
		await writer.write(data);
		await writer.close();
	})();

	const readPromise = (async () => {
		const reader = cs.readable.getReader();
		try {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value instanceof Uint8Array) chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	})();

	await Promise.all([writePromise, readPromise]);

	const total = chunks.reduce((s, c) => s + c.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const c of chunks) { out.set(c, pos); pos += c.length; }
	return out;
}

// RFC 1951 non-compressed (stored) block: BFINAL=1, BTYPE=00
// Overhead is 5 bytes regardless of content, so it always fits within BGZF limits.
function storeDeflateRaw(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + data.length);
	out[0] = 0x01; // BFINAL=1, BTYPE=00
	out[1] = data.length & 0xff;
	out[2] = (data.length >> 8) & 0xff;
	const nlen = (~data.length) & 0xffff;
	out[3] = nlen & 0xff;
	out[4] = (nlen >> 8) & 0xff;
	out.set(data, 5);
	return out;
}

// ---- BGZF block ----

// BGZF per-block overhead: 18-byte header + 4-byte CRC32 + 4-byte ISIZE = 26 bytes
const BGZF_OVERHEAD = 26;

export async function createBgzfBlock(uncompressed: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	let deflated = await compressDeflate(uncompressed);
	const crc32 = calculateCrc32(uncompressed);

	// Fall back to stored block if deflate expanded the data beyond the 65536-byte BGZF limit
	if (deflated.length + BGZF_OVERHEAD > 65536) {
		deflated = storeDeflateRaw(uncompressed);
	}

	const blockSize = BGZF_OVERHEAD + deflated.length;
	if (blockSize > 65536) throw new Error(`BGZF block size ${blockSize} exceeds 65536 bytes.`);
	const block = new Uint8Array(blockSize);
	let o = 0;
	block[o++] = 0x1f; block[o++] = 0x8b; block[o++] = 0x08; block[o++] = 0x04;
	block[o++] = 0; block[o++] = 0; block[o++] = 0; block[o++] = 0;
	block[o++] = 0; block[o++] = 0xff;
	block[o++] = 6 & 0xff; block[o++] = (6 >> 8) & 0xff;
	block[o++] = 0x42; block[o++] = 0x43; block[o++] = 0x02; block[o++] = 0x00;
	const bsize = blockSize - 1;
	block[o++] = bsize & 0xff; block[o++] = (bsize >> 8) & 0xff;
	block.set(deflated, o); o += deflated.length;
	block[o++] = crc32 & 0xff; block[o++] = (crc32 >> 8) & 0xff;
	block[o++] = (crc32 >> 16) & 0xff; block[o++] = (crc32 >> 24) & 0xff;
	const isize = uncompressed.length;
	block[o++] = isize & 0xff; block[o++] = (isize >> 8) & 0xff;
	block[o++] = (isize >> 16) & 0xff; block[o++] = (isize >> 24) & 0xff;

	return block;
}

// ---- Tar header (ustar) ----

const enc = new TextEncoder();

function writeString(buf: Uint8Array, offset: number, str: string, maxLen: number): void {
	buf.set(enc.encode(str).slice(0, maxLen), offset);
}

function writeOctal(buf: Uint8Array, offset: number, value: number, len: number): void {
	writeString(buf, offset, value.toString(8).padStart(len - 1, '0'), len);
}

function createTarHeader(name: string, size: number, mtime: number, type: '0' | '5' = '0'): Uint8Array {
	const header = new Uint8Array(512);
	writeString(header, 0, name, 100);
	writeString(header, 100, type === '5' ? '0000755\0' : '0000644\0', 8);
	writeString(header, 108, '0000000\0', 8);
	writeString(header, 116, '0000000\0', 8);
	writeOctal(header, 124, size, 12);
	writeOctal(header, 136, Math.floor(mtime / 1000), 12);
	header.fill(32, 148, 156);
	header[156] = type === '5' ? 53 : 48;
	writeString(header, 257, 'ustar', 5);
	writeString(header, 263, '00', 2);
	let checksum = 0;
	for (let i = 0; i < 512; i++) checksum += header[i];
	writeString(header, 148, checksum.toString(8).padStart(6, '0'), 6);
	header[154] = 0; header[155] = 32;
	return header;
}

// ---- Public types ----

/** A file to include in a tar or BGZF tar archive. */
export interface FileEntry {
	path: string;
	file: File;
}

export interface TarGzIndex {
	path: string;
	mimeType: string;
	aStart: number;
	aFirstEnd: number;
	aFinalStart: number;
	aEnd: number;
	rStartOffset: number;
	rEndOffset: number;
}

/** Index entry for a file within a plain tar archive. */
export interface TarIndex {
	path: string;
	mimeType: string;
	offset: number; // byte offset of file data start within the tar
	size: number; // file data byte count
}

export interface ArchiveProgress {
	processedFiles: number;
	totalFiles: number;
	currentFile: string;
	processedBytes: number;
	totalBytes: number;
}

// ---- TarArchiver ----

const BGZF_BLOCK_SIZE = 65000;

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

// Shared base — not exported. TarArchiver and BgzfTarArchiver extend this independently
// to avoid a TypeScript static-side compatibility error (TS2417) that would arise if one
// extended the other while both define create() with incompatible return types.
class TarArchiverBase<TIdx> {
	readonly stream: ReadableStream<Uint8Array>;
	readonly index: Promise<TIdx[]>;

	protected constructor(stream: ReadableStream<Uint8Array>, index: Promise<TIdx[]>) {
		this.stream = stream;
		this.index = index;
	}

	/** Recursively walk a directory, yielding each file as a FileEntry. */
	static async* walkDirectory(dir: FileSystemDirectoryHandle, prefix = ''): AsyncGenerator<FileEntry> {
		for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
			if (handle.kind === 'file') {
				yield { path: prefix + name, file: await (handle as FileSystemFileHandle).getFile() };
			} else {
				yield* TarArchiverBase.walkDirectory(handle as FileSystemDirectoryHandle, prefix + name + '/');
			}
		}
	}

	/** Walk a directory and detect MIME types for all files in parallel. */
	protected static async prepareEntries(dir: FileSystemDirectoryHandle): Promise<PreparedEntry[]> {
		const now = Date.now();
		const walked: FileEntry[] = [];
		for await (const entry of TarArchiverBase.walkDirectory(dir)) walked.push(entry);
		const { fileTypeFromBlob } = await import('file-type');
		return Promise.all(
			walked.map(async ({ path, file }) => {
				const detected = await fileTypeFromBlob(file);
				return {
					path,
					file,
					mimeType: detected?.mime ?? file.type,
					mtime: file.lastModified || now,
				};
			}),
		);
	}
}

/** Uncompressed tar archiver with a byte-offset index. Use `TarArchiver.create()` to construct. */
export class TarArchiver extends TarArchiverBase<TarIndex> {
	/** Create an uncompressed tar archiver for the given directory. */
	static async create(dir: FileSystemDirectoryHandle, onProgress?: (p: ArchiveProgress) => void): Promise<TarArchiver> {
		const entries = await TarArchiverBase.prepareEntries(dir);
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
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
			yield new Uint8Array(1024); // end-of-archive
			resolveIndex(tarEntries);
		})();

		return new TarArchiver(makePullStream(gen, rejectIndex), index);
	}
}

/** BGZF-compressed tar archiver with a block-level random-access index. Use `BgzfTarArchiver.create()` to construct. */
export class BgzfTarArchiver extends TarArchiverBase<TarGzIndex> {
	/** Create a BGZF-compressed tar archiver for the given directory. */
	static async create(dir: FileSystemDirectoryHandle, onProgress?: (p: ArchiveProgress) => void): Promise<BgzfTarArchiver> {
		const entries = await TarArchiverBase.prepareEntries(dir);
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
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
			yield* writeBytes(new Uint8Array(1024)); // end-of-archive

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
