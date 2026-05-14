import { fileTypeFromBlob } from 'file-type';

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

async function compressDeflate(data: Uint8Array): Promise<Uint8Array> {
	// 'deflate-raw' = RFC 1951 raw deflate, required by BGZF (gzip CDATA)
	const cs = new CompressionStream('deflate-raw');
	const writer = cs.writable.getWriter();
	await writer.write(new Uint8Array(data));
	await writer.close();
	const chunks: Uint8Array[] = [];
	const reader = cs.readable.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value instanceof Uint8Array) chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
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

export async function createBgzfBlock(uncompressed: Uint8Array): Promise<Uint8Array> {
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

// ---- File System Access API walker ----

/**
 * Walk a FileSystemDirectoryHandle recursively, yielding FileEntry for each file.
 */
export async function* walkDirectory(
	dir: FileSystemDirectoryHandle,
	prefix = '',
): AsyncGenerator<FileEntry> {
	for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
		if (handle.kind === 'file') {
			yield { path: prefix + name, file: await (handle as FileSystemFileHandle).getFile() };
		} else if (handle.kind === 'directory') {
			yield* walkDirectory(handle as FileSystemDirectoryHandle, prefix + name + '/');
		}
	}
}

async function resolveSource(source: FileEntry[] | FileSystemDirectoryHandle): Promise<FileEntry[]> {
	if (Array.isArray(source)) return source;
	const files: FileEntry[] = [];
	for await (const entry of walkDirectory(source)) files.push(entry);
	return files;
}

// ---- createTar ----

/**
 * Create an uncompressed tar (ustar) archive as a ReadableStream.
 * Accepts a FileEntry[] or a FileSystemDirectoryHandle.
 * File contents are streamed — no full-file memory buffering.
 */
export function createTar(source: FileEntry[] | FileSystemDirectoryHandle): ReadableStream<Uint8Array> {
	const gen = (async function* () {
		const files = await resolveSource(source);
		for (const { path, file } of files) {
			yield createTarHeader(path, file.size, file.lastModified);
			const reader = file.stream().getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					yield value;
				}
			} finally {
				reader.releaseLock();
			}
			const padLen = (512 - (file.size % 512)) % 512;
			if (padLen > 0) yield new Uint8Array(padLen);
		}
		yield new Uint8Array(1024); // end-of-archive
	})();

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done } = await gen.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (err) {
				controller.error(err);
			}
		},
		cancel() { gen.return(undefined); },
	});
}

// ---- createBgzfTar ----

/**
 * Create a BGZF-compressed tar archive with a random-access index.
 * Accepts a FileEntry[] or a FileSystemDirectoryHandle.
 * MIME types are detected with fileTypeFromBlob (reads first few KB only).
 * File data and BGZF blocks are streamed — no bulk memory buffering.
 * The index resolves after the stream is fully consumed.
 */
export async function createBgzfTar(
	source: FileEntry[] | FileSystemDirectoryHandle,
): Promise<{ stream: ReadableStream<Uint8Array>; index: Promise<TarGzIndex[]> }> {
	const files = await resolveSource(source);
	const BLOCK_SIZE = 65000;
	const now = Date.now();

	// Detect MIME types using fileTypeFromBlob (reads first few KB, no full-file buffer)
	const entries = await Promise.all(
		files.map(async ({ path, file }) => {
			const detected = await fileTypeFromBlob(file);
			return { path, file, mimeType: detected?.mime ?? 'application/octet-stream', mtime: file.lastModified || now };
		}),
	);

	let resolveIndex!: (v: TarGzIndex[]) => void;
	let rejectIndex!: (e: unknown) => void;
	const index = new Promise<TarGzIndex[]>((res, rej) => { resolveIndex = res; rejectIndex = rej; });

	// Async generator: yields one BGZF block per iteration.
	// Block metadata (offsets/sizes) is tracked without storing block bytes.
	const gen = (async function* () {
		const blockOffsets: number[] = [];
		const blockLengths: number[] = [];
		let compressedOffset = 0;
		let totalWritten = 0;
		const blockBuffer = new Uint8Array(BLOCK_SIZE);
		let bufLen = 0;
		const fileBounds: { path: string; mimeType: string; start: number; end: number }[] = [];

		// Write bytes into the block buffer, yielding a compressed block whenever it fills.
		async function* writeBytes(data: Uint8Array): AsyncGenerator<Uint8Array> {
			let pos = 0;
			while (pos < data.length) {
				const n = Math.min(BLOCK_SIZE - bufLen, data.length - pos);
				blockBuffer.set(data.subarray(pos, pos + n), bufLen);
				bufLen += n;
				totalWritten += n;
				pos += n;
				if (bufLen === BLOCK_SIZE) {
					const block = await createBgzfBlock(blockBuffer.slice(0, bufLen));
					blockOffsets.push(compressedOffset);
					blockLengths.push(block.length);
					compressedOffset += block.length;
					bufLen = 0;
					yield block;
				}
			}
		}

		for (const entry of entries) {
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
		}
		yield* writeBytes(new Uint8Array(1024)); // end-of-archive

		// Flush remaining partial block
		if (bufLen > 0) {
			const block = await createBgzfBlock(blockBuffer.slice(0, bufLen));
			blockOffsets.push(compressedOffset);
			blockLengths.push(block.length);
			compressedOffset += block.length;
			bufLen = 0;
			yield block;
		}

		// BGZF EOF block
		const eofBlock = await createBgzfBlock(new Uint8Array(0));
		blockOffsets.push(compressedOffset);
		blockLengths.push(eofBlock.length);
		yield eofBlock;

		// Build and resolve index now that all block offsets are known
		const totalUncompressed = totalWritten;
		resolveIndex(fileBounds.map((fb) => {
			const startBlockIdx = Math.floor(fb.start / BLOCK_SIZE);
			const endBlockIdx = Math.floor(Math.max(fb.end - 1, fb.start) / BLOCK_SIZE);
			const rStartOffset = fb.start - startBlockIdx * BLOCK_SIZE;
			const rEndOffset = Math.min((endBlockIdx + 1) * BLOCK_SIZE, totalUncompressed) - fb.end;
			return {
				path: fb.path,
				mimeType: fb.mimeType,
				aStart: blockOffsets[startBlockIdx],
				aFirstEnd: blockOffsets[startBlockIdx] + blockLengths[startBlockIdx],
				aFinalStart: blockOffsets[endBlockIdx],
				aEnd: blockOffsets[endBlockIdx] + blockLengths[endBlockIdx],
				rStartOffset,
				rEndOffset,
			};
		}));
	})();

	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done } = await gen.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (err) {
				rejectIndex(err);
				controller.error(err);
			}
		},
		cancel() {
			gen.return(undefined);
			rejectIndex(new Error('Stream cancelled'));
		},
	});

	return { stream, index };
}
