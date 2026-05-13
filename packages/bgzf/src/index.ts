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
