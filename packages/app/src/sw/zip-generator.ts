/**
 * Minimal streaming ZIP generator (DEFLATE or STORE per entry).
 *
 * Produces a valid ZIP file from a sequence of entries, each provided as a
 * ReadableStream of raw (uncompressed) bytes.
 *
 * Format overview (PKWARE APPNOTE §4.3):
 *  - [Local File Header + compressed data] × N
 *  - Central Directory records × N
 *  - End of Central Directory record
 *
 * We use ZIP64 for offsets/sizes > 0xFFFFFFFF to support large archives.
 * However, each entry's *actual* CRC32 and compressed size are not known
 * until the data is fully produced. We write them in a Data Descriptor
 * (signature 0x08074b50) after the compressed data and set the corresponding
 * flag (bit 3) in the Local File Header so conformant extractors wait for it.
 * The Central Directory always contains the correct values.
 *
 * Compression: DEFLATE (method 8) using DecompressionStream/CompressionStream.
 * The Service Worker environment supports CompressionStream('deflate-raw').
 *
 * CRC-32: computed via a lookup table, compatible with PKZIP.
 */

// ---------------------------------------------------------------------------
// CRC-32 table (pre-computed polynomial 0xEDB88320)
// ---------------------------------------------------------------------------

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c;
	}
	return table;
})();

function crc32(crc: number, data: Uint8Array<ArrayBuffer>): number {
	let c = crc ^ 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Little-endian write helpers
// ---------------------------------------------------------------------------

function writeUint16LE(buf: DataView, offset: number, val: number): void {
	buf.setUint16(offset, val, true);
}

function writeUint32LE(buf: DataView, offset: number, val: number): void {
	buf.setUint32(offset, val, true);
}

function writeUint64LE(buf: DataView, offset: number, val: bigint): void {
	buf.setBigUint64(offset, val, true);
}

// ---------------------------------------------------------------------------
// Entry metadata collected during streaming (used for Central Directory)
// ---------------------------------------------------------------------------

interface CdEntry {
	nameBytes: Uint8Array<ArrayBuffer>;
	crc: number;
	compressedSize: bigint;
	uncompressedSize: bigint;
	localHeaderOffset: bigint;
	/** 0 = STORE, 8 = DEFLATE */
	method: number;
	/** MS-DOS date+time packed values */
	dosDate: number;
	dosTime: number;
}

function getDosDateTime(): { dosDate: number; dosTime: number } {
	const now = new Date();
	const dosDate =
		((now.getFullYear() - 1980) << 9) |
		((now.getMonth() + 1) << 5) |
		now.getDate();
	const dosTime =
		(now.getHours() << 11) |
		(now.getMinutes() << 5) |
		Math.floor(now.getSeconds() / 2);
	return { dosDate, dosTime };
}

// ---------------------------------------------------------------------------
// Compress a readable stream entry with DEFLATE-raw, updating CRC/sizes
// ---------------------------------------------------------------------------

/**
 * Compress one file entry via DeflateRaw.
 * Returns compressed chunks + final CRC32 + sizes.
 *
 * Write and read of the CompressionStream run concurrently per ecma-stream rules.
 */
async function compressEntry(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	onChunk: (chunk: Uint8Array<ArrayBuffer>) => void,
): Promise<{ crc: number; compressedSize: bigint; uncompressedSize: bigint }> {
	const cs = new CompressionStream('deflate-raw');
	let crc = 0;
	let uncompressedSize = 0n;
	let compressedSize = 0n;

	// Write side: read the input stream and feed into CompressionStream
	const writePromise = (async () => {
		const inputReader = stream.getReader();
		const writer = cs.writable.getWriter();
		try {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			while (true) {
				const { done, value } = await inputReader.read();
				if (done) break;
				crc = crc32(crc, value);
				uncompressedSize += BigInt(value.length);
				await writer.write(value);
			}
			await writer.close();
		} finally {
			inputReader.releaseLock();
		}
	})();

	// Read side: pull compressed chunks and track compressed size
	const readPromise = (async () => {
		const reader = cs.readable.getReader();
		try {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				compressedSize += BigInt(value.length);
				onChunk(value);
			}
		} finally {
			reader.releaseLock();
		}
	})();

	await Promise.all([writePromise, readPromise]);
	return { crc, compressedSize, uncompressedSize };
}

// ---------------------------------------------------------------------------
// Local File Header builders
// ---------------------------------------------------------------------------

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD_SIG = 0x06054b50;

/**
 * Build the Local File Header for one entry.
 * Bit 3 set: CRC and sizes are in the trailing Data Descriptor.
 * We always write ZIP64 extra field so compressed/uncompressed size fields
 * in the LFH are 0xFFFFFFFF (placeholder).
 */
function buildLocalFileHeader(
	nameBytes: Uint8Array<ArrayBuffer>,
	method: number,
	dosDate: number,
	dosTime: number,
): Uint8Array<ArrayBuffer> {
	const extraLen = 20; // ZIP64: tag(2)+size(2)+uncompSize(8)+compSize(8)
	const totalLen = 30 + nameBytes.length + extraLen;
	const buf = new ArrayBuffer(totalLen);
	const view = new DataView(buf);
	const arr = new Uint8Array(buf);

	writeUint32LE(view, 0, LOCAL_FILE_HEADER_SIG);
	writeUint16LE(view, 4, 45); // version needed: 4.5 (ZIP64)
	writeUint16LE(view, 6, 0x0808); // general purpose bit flag: bit3=data descriptor, bit11=UTF-8
	writeUint16LE(view, 8, method);
	writeUint16LE(view, 10, dosTime);
	writeUint16LE(view, 12, dosDate);
	writeUint32LE(view, 14, 0); // CRC-32 (deferred)
	writeUint32LE(view, 18, 0xffffffff); // compressed size placeholder
	writeUint32LE(view, 22, 0xffffffff); // uncompressed size placeholder
	writeUint16LE(view, 26, nameBytes.length);
	writeUint16LE(view, 28, extraLen);
	arr.set(nameBytes, 30);

	// ZIP64 extra field
	const extraOffset = 30 + nameBytes.length;
	writeUint16LE(view, extraOffset, 0x0001); // ZIP64 tag
	writeUint16LE(view, extraOffset + 2, 16); // size of data (2 × uint64)
	writeUint64LE(view, extraOffset + 4, 0n); // uncompressed size (deferred)
	writeUint64LE(view, extraOffset + 12, 0n); // compressed size (deferred)

	return arr as Uint8Array<ArrayBuffer>;
}

/**
 * Build the Data Descriptor written after each entry's compressed data.
 * Uses the ZIP64 form (8-byte sizes).
 */
function buildDataDescriptor(
	crc: number,
	compressedSize: bigint,
	uncompressedSize: bigint,
): Uint8Array<ArrayBuffer> {
	const buf = new ArrayBuffer(24);
	const view = new DataView(buf);
	writeUint32LE(view, 0, DATA_DESCRIPTOR_SIG);
	writeUint32LE(view, 4, crc);
	writeUint64LE(view, 8, compressedSize);
	writeUint64LE(view, 16, uncompressedSize);
	return new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// Central Directory
// ---------------------------------------------------------------------------

function buildCentralDirRecord(entry: CdEntry): Uint8Array<ArrayBuffer> {
	const nameLen = entry.nameBytes.length;
	// ZIP64 extra: tag(2)+size(2)+uncompSize(8)+compSize(8)+offset(8) = 28 bytes
	const extraLen = 28;
	const totalLen = 46 + nameLen + extraLen;
	const buf = new ArrayBuffer(totalLen);
	const view = new DataView(buf);
	const arr = new Uint8Array(buf);

	writeUint32LE(view, 0, CENTRAL_DIR_SIG);
	writeUint16LE(view, 4, 45); // version made by: 4.5 (ZIP64, Unix-compatible)
	writeUint16LE(view, 6, 45); // version needed: 4.5 (ZIP64)
	writeUint16LE(view, 8, 0x0808); // general purpose bit flag
	writeUint16LE(view, 10, entry.method);
	writeUint16LE(view, 12, entry.dosTime);
	writeUint16LE(view, 14, entry.dosDate);
	writeUint32LE(view, 16, entry.crc);
	writeUint32LE(view, 20, 0xffffffff); // compressed size → ZIP64
	writeUint32LE(view, 24, 0xffffffff); // uncompressed size → ZIP64
	writeUint16LE(view, 28, nameLen);
	writeUint16LE(view, 30, extraLen);
	writeUint16LE(view, 32, 0); // comment length
	writeUint16LE(view, 34, 0); // disk number start
	writeUint16LE(view, 36, 0); // internal attributes
	writeUint32LE(view, 38, 0); // external attributes
	writeUint32LE(view, 42, 0xffffffff); // local header offset → ZIP64
	arr.set(entry.nameBytes, 46);

	// ZIP64 extra field
	const extraOffset = 46 + nameLen;
	writeUint16LE(view, extraOffset, 0x0001);
	writeUint16LE(view, extraOffset + 2, 24); // 3 × uint64
	writeUint64LE(view, extraOffset + 4, entry.uncompressedSize);
	writeUint64LE(view, extraOffset + 12, entry.compressedSize);
	writeUint64LE(view, extraOffset + 20, entry.localHeaderOffset);

	return arr as Uint8Array<ArrayBuffer>;
}

function buildEndOfCentralDirectory(
	entryCount: bigint,
	cdSize: bigint,
	cdOffset: bigint,
): Uint8Array<ArrayBuffer> {
	// ZIP64 EOCD (56 bytes) + ZIP64 EOCD Locator (20 bytes) + EOCD (22 bytes)
	const totalLen = 56 + 20 + 22;
	const buf = new ArrayBuffer(totalLen);
	const view = new DataView(buf);

	// ZIP64 End of Central Directory record
	writeUint32LE(view, 0, EOCD64_SIG);
	writeUint64LE(view, 4, 44n); // size of EOCD64 record (minus 12)
	writeUint16LE(view, 12, 45); // version made by
	writeUint16LE(view, 14, 45); // version needed
	writeUint32LE(view, 16, 0); // disk number
	writeUint32LE(view, 20, 0); // disk with CD start
	writeUint64LE(view, 24, entryCount); // entries on this disk
	writeUint64LE(view, 32, entryCount); // total entries
	writeUint64LE(view, 40, cdSize); // CD size
	writeUint64LE(view, 48, cdOffset); // CD offset

	// ZIP64 EOCD Locator
	writeUint32LE(view, 56, EOCD64_LOCATOR_SIG);
	writeUint32LE(view, 60, 0); // disk with EOCD64
	writeUint64LE(view, 64, cdOffset + cdSize); // offset of EOCD64
	writeUint32LE(view, 72, 1); // total disks

	// Classic EOCD (for backward compat; sizes clamped to 0xFFFF/0xFFFFFFFF)
	writeUint32LE(view, 76, EOCD_SIG);
	writeUint16LE(view, 80, 0); // disk number
	writeUint16LE(view, 82, 0); // disk with CD start
	writeUint16LE(view, 84, entryCount > 0xffffn ? 0xffff : Number(entryCount));
	writeUint16LE(view, 86, entryCount > 0xffffn ? 0xffff : Number(entryCount));
	writeUint32LE(view, 88, cdSize > 0xffffffffn ? 0xffffffff : Number(cdSize));
	writeUint32LE(view, 92, cdOffset > 0xffffffffn ? 0xffffffff : Number(cdOffset));
	writeUint16LE(view, 96, 0); // comment length

	return new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ZipEntry {
	name: string;
	/** Raw (uncompressed) file data stream */
	stream: ReadableStream<Uint8Array<ArrayBuffer>>;
}

/**
 * Generate a ZIP archive ReadableStream from an async iterable of entries.
 *
 * Each entry's stream is consumed exactly once in order. The resulting ZIP
 * uses DEFLATE compression and Data Descriptors for streaming (no seeking).
 */
export function generateZip(
	entries: AsyncIterable<ZipEntry>,
): ReadableStream<Uint8Array<ArrayBuffer>> {
	const enc = new TextEncoder();
	const cdRecords: CdEntry[] = [];
	let offset = 0n;

	return new ReadableStream<Uint8Array<ArrayBuffer>>({
		async start(controller) {
			try {
				for await (const entry of entries) {
					const nameBytes = enc.encode(entry.name) as Uint8Array<ArrayBuffer>;
					const { dosDate, dosTime } = getDosDateTime();
					const method = 8; // DEFLATE

					// Local File Header
					const lfh = buildLocalFileHeader(nameBytes, method, dosDate, dosTime);
					controller.enqueue(lfh);
					const localHeaderOffset = offset;
					offset += BigInt(lfh.length);

					// Compressed data chunks
					const compressedChunks: Array<Uint8Array<ArrayBuffer>> = [];
					const { crc, compressedSize, uncompressedSize } = await compressEntry(
						entry.stream,
						chunk => {
							controller.enqueue(chunk);
							offset += BigInt(chunk.length);
						},
					);
					void compressedChunks; // chunks already enqueued

					// Data Descriptor
					const dd = buildDataDescriptor(crc, compressedSize, uncompressedSize);
					controller.enqueue(dd);
					offset += BigInt(dd.length);

					cdRecords.push({
						nameBytes,
						crc,
						compressedSize,
						uncompressedSize,
						localHeaderOffset,
						method,
						dosDate,
						dosTime,
					});
				}

				// Central Directory
				const cdOffset = offset;
				let cdSize = 0n;
				for (const rec of cdRecords) {
					const cd = buildCentralDirRecord(rec);
					controller.enqueue(cd);
					cdSize += BigInt(cd.length);
				}

				// End of Central Directory
				const eocd = buildEndOfCentralDirectory(BigInt(cdRecords.length), cdSize, cdOffset);
				controller.enqueue(eocd);

				controller.close();
			} catch (err) {
				controller.error(err);
			}
		},
	});
}
