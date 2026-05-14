/**
 * CRC-32 calculation for BGZF footer
 */
export function calculateCrc32(data: Uint8Array): number {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}

	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Compress data to raw deflate format (without gzip wrapper)
 */
export async function compressDeflate(data: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream('deflate');
	const writer = cs.writable.getWriter();
	// Create a copy to ensure regular ArrayBuffer (not SharedArrayBuffer)
	const normalizedData = new Uint8Array(data);
	await writer.write(normalizedData);
	await writer.close();

	const chunks: Uint8Array[] = [];
	const reader = cs.readable.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value instanceof Uint8Array) {
				chunks.push(value);
			}
		}
	} finally {
		reader.releaseLock();
	}

	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/**
 * Create BGZF block from uncompressed data
 * Includes BGZF header, deflate-compressed data, and CRC-32/ISIZE footer
 */
export async function createBgzfBlock(uncompressed: Uint8Array): Promise<Uint8Array> {
	const deflated = await compressDeflate(uncompressed);

	// Calculate CRC-32
	const crc32 = calculateCrc32(uncompressed);

	// BGZF block structure:
	// Header (10 bytes) + Extra subfield (8 bytes) + compressed data + footer (8 bytes)
	const blockSize = 10 + 8 + deflated.length + 8;

	// Check BGZF block size limit (65536 bytes)
	if (blockSize > 65536) {
		throw new Error(
			`BGZF block size ${blockSize} exceeds maximum 65536 bytes. Data too large for single block.`
		);
	}

	const block = new Uint8Array(blockSize);
	let offset = 0;

	// GZIP header (RFC 1952)
	block[offset++] = 0x1f; // ID1
	block[offset++] = 0x8b; // ID2
	block[offset++] = 0x08; // Compression method (deflate)
	block[offset++] = 0x04; // Flags (FNAME flag for BGZF)
	// Modification time (4 bytes) - set to 0
	block[offset++] = 0;
	block[offset++] = 0;
	block[offset++] = 0;
	block[offset++] = 0;
	block[offset++] = 0; // Extra flags
	block[offset++] = 0xff; // OS (unknown)

	// Extra subfield for BGZF (8 bytes total)
	// XLEN (extra field length) = 6 bytes
	const xlen = 6;
	block[offset++] = xlen & 0xff;
	block[offset++] = (xlen >> 8) & 0xff;

	// BGZF subfield
	block[offset++] = 0x42; // SI1 ('B')
	block[offset++] = 0x43; // SI2 ('C')
	block[offset++] = 0x02; // LEN (length of BGZF subfield data)
	block[offset++] = 0x00; // LEN continued

	// BSIZE (total block size including header and footer, little-endian)
	const bsize = blockSize - 1; // BSIZE doesn't include itself in some implementations, but standard includes it
	block[offset++] = bsize & 0xff;
	block[offset++] = (bsize >> 8) & 0xff;

	// Compressed data
	block.set(deflated, offset);
	offset += deflated.length;

	// Footer: CRC-32 (little-endian, 4 bytes)
	block[offset++] = crc32 & 0xff;
	block[offset++] = (crc32 >> 8) & 0xff;
	block[offset++] = (crc32 >> 16) & 0xff;
	block[offset++] = (crc32 >> 24) & 0xff;

	// ISIZE (uncompressed size, little-endian, 4 bytes, modulo 2^32)
	const isize = uncompressed.length;
	block[offset++] = isize & 0xff;
	block[offset++] = (isize >> 8) & 0xff;
	block[offset++] = (isize >> 16) & 0xff;
	block[offset++] = (isize >> 24) & 0xff;

	return block;
}

const enc = new TextEncoder();

function writeString(buf: Uint8Array, offset: number, str: string, maxLen: number): void {
	const bytes = enc.encode(str);
	buf.set(bytes.slice(0, maxLen), offset);
}

function writeOctal(buf: Uint8Array, offset: number, value: number, len: number): void {
	const str = value.toString(8).padStart(len - 1, '0');
	writeString(buf, offset, str, len);
	// null terminator already present in zeroed array
}

/**
 * Create a ustar-format tar header block (512 bytes)
 */
export function createTarHeader(name: string, size: number, mtime: number, type: '0' | '5' = '0'): Uint8Array {
	const header = new Uint8Array(512);

	// Truncate name to 100 bytes
	writeString(header, 0, name, 100);
	// Mode
	writeString(header, 100, type === '5' ? '0000755\0' : '0000644\0', 8);
	// UID / GID
	writeString(header, 108, '0000000\0', 8);
	writeString(header, 116, '0000000\0', 8);
	// Size (12 bytes octal)
	writeOctal(header, 124, size, 12);
	// Modification time
	writeOctal(header, 136, Math.floor(mtime / 1000), 12);
	// Checksum placeholder = all spaces
	header.fill(32, 148, 156);
	// Type flag
	header[156] = type === '5' ? 53 : 48; // '5' or '0'
	// ustar magic + version
	writeString(header, 257, 'ustar', 5);
	writeString(header, 263, '00', 2);

	// Compute checksum over all 512 bytes (checksum field treated as spaces)
	let checksum = 0;
	for (let i = 0; i < 512; i++) {
		checksum += header[i];
	}
	// Write checksum: 6 octal digits + null + space
	const csStr = checksum.toString(8).padStart(6, '0');
	writeString(header, 148, csStr, 6);
	header[154] = 0;
	header[155] = 32; // space

	return header;
}

export interface TarFileEntry {
	path: string;
	data: Uint8Array<ArrayBuffer>;
	mimeType: string;
	mtime?: number;
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

/**
 * Create a BGZF-compressed tar archive with an index for random access.
 * Each BGZF block contains up to BLOCK_SIZE bytes of uncompressed tar data.
 * Returns the .tar.gz bytes and the index needed by /api/files/create/targz-index.
 */
export async function createBgzfTar(entries: TarFileEntry[]): Promise<{ data: Uint8Array; index: TarGzIndex[] }> {
	// Max uncompressed bytes per BGZF block (conservative: compressed must fit in 65536)
	const BLOCK_SIZE = 65000;

	// Build uncompressed tar stream and record file data boundaries
	const parts: Uint8Array[] = [];
	const fileBounds: { path: string; mimeType: string; start: number; end: number }[] = [];
	let pos = 0;
	const now = Date.now();

	for (const entry of entries) {
		const header = createTarHeader(entry.path, entry.data.length, entry.mtime ?? now);
		// Data padded to 512-byte boundary
		const padLen = (512 - (entry.data.length % 512)) % 512;
		const padding = new Uint8Array(padLen);

		// file data starts after 512-byte header
		const dataStart = pos + 512;
		parts.push(header, entry.data, padding);

		fileBounds.push({
			path: entry.path,
			mimeType: entry.mimeType,
			start: dataStart,
			end: dataStart + entry.data.length,
		});

		pos += 512 + entry.data.length + padLen;
	}

	// Two 512-byte null blocks = end-of-archive
	parts.push(new Uint8Array(1024));
	const totalUncompressed = pos + 1024;

	// Concatenate all tar data
	const tarData = new Uint8Array(totalUncompressed);
	let writePos = 0;
	for (const part of parts) {
		tarData.set(part, writePos);
		writePos += part.length;
	}

	// Compress into BGZF blocks and record each block's byte offset in the output
	const bgzfBlocks: Uint8Array[] = [];
	const bgzfStartOffsets: number[] = [];
	let bgzfOffset = 0;

	for (let i = 0; i < tarData.length; i += BLOCK_SIZE) {
		const chunk = tarData.slice(i, Math.min(i + BLOCK_SIZE, tarData.length));
		const block = await createBgzfBlock(chunk);
		bgzfStartOffsets.push(bgzfOffset);
		bgzfBlocks.push(block);
		bgzfOffset += block.length;
	}

	// BGZF EOF block (empty)
	const eofBlock = await createBgzfBlock(new Uint8Array(0));
	bgzfBlocks.push(eofBlock);

	// Build index: for each file find which blocks it spans
	const index: TarGzIndex[] = [];
	for (const fb of fileBounds) {
		const startBlockIdx = Math.floor(fb.start / BLOCK_SIZE);
		const endBlockIdx = Math.floor(Math.max(fb.end - 1, fb.start) / BLOCK_SIZE);

		const rStartOffset = fb.start - startBlockIdx * BLOCK_SIZE;
		const endBlockDataEnd = (endBlockIdx + 1) * BLOCK_SIZE;
		const rEndOffset = Math.min(endBlockDataEnd, totalUncompressed) - fb.end;

		index.push({
			path: fb.path,
			mimeType: fb.mimeType,
			aStart: bgzfStartOffsets[startBlockIdx],
			aFirstEnd: bgzfStartOffsets[startBlockIdx] + bgzfBlocks[startBlockIdx].length,
			aFinalStart: bgzfStartOffsets[endBlockIdx],
			aEnd: bgzfStartOffsets[endBlockIdx] + bgzfBlocks[endBlockIdx].length,
			rStartOffset,
			rEndOffset,
		});
	}

	// Combine all BGZF blocks into final output
	const totalSize = bgzfBlocks.reduce((sum, b) => sum + b.length, 0);
	const output = new Uint8Array(totalSize);
	let outPos = 0;
	for (const block of bgzfBlocks) {
		output.set(block, outPos);
		outPos += block.length;
	}

	return { data: output, index };
}
