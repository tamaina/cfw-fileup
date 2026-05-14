import { describe, test, expect } from 'vitest';
import { createBgzfBlock, TarArchiver, BgzfTarArchiver } from '../src/index';

// ---- Test helpers ----

function crc32(data: Uint8Array): number {
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

function u16le(buf: Uint8Array, off: number): number {
	return buf[off] | (buf[off + 1] << 8);
}

function u32le(buf: Uint8Array, off: number): number {
	return (buf[off] | buf[off + 1] << 8 | buf[off + 2] << 16 | buf[off + 3] << 24) >>> 0;
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const total = chunks.reduce((s, c) => s + c.length, 0);
	const buf = new Uint8Array(total);
	let pos = 0;
	for (const c of chunks) { buf.set(c, pos); pos += c.length; }
	return buf;
}

// Parses one BGZF block at buf[offset]; returns structural fields
function parseBgzfBlock(buf: Uint8Array, offset: number) {
	if (buf[offset] !== 0x1f || buf[offset + 1] !== 0x8b)
		throw new Error(`No gzip magic at offset ${offset}`);
	const blockSize = u16le(buf, offset + 16) + 1;
	const cdata = buf.slice(offset + 18, offset + blockSize - 8);
	const storedCrc32 = u32le(buf, offset + blockSize - 8);
	const isize = u32le(buf, offset + blockSize - 4);
	return { blockSize, cdata, storedCrc32, isize };
}

// Decompresses raw deflate data
async function decompressRaw(data: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream('deflate-raw');
	const writer = ds.writable.getWriter();
	await writer.write(new Uint8Array(data));
	await writer.close();
	const chunks: Uint8Array[] = [];
	const reader = ds.readable.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
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

// Decompresses a complete BGZF stream (stops at EOF marker block with ISIZE=0)
async function decompressBgzf(buf: Uint8Array): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	while (offset < buf.length) {
		const { blockSize, cdata, isize } = parseBgzfBlock(buf, offset);
		if (isize === 0) break; // EOF marker
		chunks.push(await decompressRaw(cdata));
		offset += blockSize;
	}
	const total = chunks.reduce((s, c) => s + c.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const c of chunks) { out.set(c, pos); pos += c.length; }
	return out;
}

interface TarEntry { path: string; size: number; data: Uint8Array }

function parseTar(buf: Uint8Array): TarEntry[] {
	const dec = new TextDecoder();
	const entries: TarEntry[] = [];
	let offset = 0;
	while (offset + 512 <= buf.length) {
		if (buf[offset] === 0) break;
		const path = dec.decode(buf.slice(offset, offset + 100)).replace(/\0.*$/, '');
		const size = parseInt(dec.decode(buf.slice(offset + 124, offset + 136)).replace(/\0.*$/, '').trim(), 8);
		offset += 512;
		entries.push({ path, size, data: buf.slice(offset, offset + size) });
		offset += size + (512 - (size % 512)) % 512;
	}
	return entries;
}

// ---- Mock FileSystem handles ----

function mockFileHandle(name: string, content: Uint8Array<ArrayBuffer>): FileSystemFileHandle {
	const file = new File([content], name);
	return { kind: 'file' as const, name, getFile: async () => file } as unknown as FileSystemFileHandle;
}

function mockDir(entries: Array<[string, FileSystemHandle]>): FileSystemDirectoryHandle {
	return {
		kind: 'directory' as const,
		name: 'mock',
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				async next() {
					if (i >= entries.length) return { done: true as const, value: undefined as unknown as [string, FileSystemHandle] };
					return { done: false as const, value: entries[i++] };
				},
			};
		},
	} as unknown as FileSystemDirectoryHandle;
}

const enc = new TextEncoder();

// ---- createBgzfBlock ----

describe('createBgzfBlock', () => {
	test('header bytes are correct for non-empty input', async () => {
		const block = await createBgzfBlock(enc.encode('Hello'));
		// gzip magic
		expect(block[0]).toBe(0x1f);
		expect(block[1]).toBe(0x8b);
		// CM = deflate
		expect(block[2]).toBe(0x08);
		// FLG = FEXTRA
		expect(block[3]).toBe(0x04);
		// MTIME = 0
		expect(u32le(block, 4)).toBe(0);
		// XFL = 0, OS = 0xff
		expect(block[8]).toBe(0x00);
		expect(block[9]).toBe(0xff);
		// XLEN = 6
		expect(u16le(block, 10)).toBe(6);
		// BC subfield ID
		expect(block[12]).toBe(0x42); // 'B'
		expect(block[13]).toBe(0x43); // 'C'
		// SLEN = 2
		expect(u16le(block, 14)).toBe(2);
		// BSIZE field encodes blockSize - 1
		expect(u16le(block, 16)).toBe(block.length - 1);
	});

	test('ISIZE equals input length', async () => {
		const input = enc.encode('Hello, BGZF!');
		const block = await createBgzfBlock(input);
		expect(u32le(block, block.length - 4)).toBe(input.length);
	});

	test('stored CRC32 matches CRC32 of input', async () => {
		const input = enc.encode('CRC check data');
		const block = await createBgzfBlock(input);
		const storedCrc = u32le(block, block.length - 8);
		expect(storedCrc).toBe(crc32(input));
	});

	test('CDATA decompresses back to the original input', async () => {
		const input = enc.encode('Round-trip test data');
		const block = await createBgzfBlock(input);
		const { cdata } = parseBgzfBlock(block, 0);
		const decompressed = await decompressRaw(cdata);
		expect(decompressed).toEqual(input);
	});

	test('empty input produces a valid EOF-marker block (ISIZE=0, CRC32=0)', async () => {
		const block = await createBgzfBlock(new Uint8Array(0));
		// Must still be a valid gzip header
		expect(block[0]).toBe(0x1f);
		expect(block[1]).toBe(0x8b);
		expect(u32le(block, block.length - 4)).toBe(0); // ISIZE = 0
		expect(u32le(block, block.length - 8)).toBe(0); // CRC32 of empty = 0
	});

	test('block size stays within 65536 bytes for large input', async () => {
		// Feed the maximum uncompressed block size (65000 bytes)
		const input = new Uint8Array(65000).fill(0x41); // all 'A's — compressible
		const block = await createBgzfBlock(input);
		expect(block.length).toBeLessThanOrEqual(65536);
		expect(u32le(block, block.length - 4)).toBe(65000);
		expect(u32le(block, block.length - 8)).toBe(crc32(input));
	});
});

// ---- TarArchiver ----

describe('TarArchiver', () => {
	test('walkDirectory yields all files with correct paths', async () => {
		const dir = mockDir([
			['a.txt', mockFileHandle('a.txt', enc.encode('aaa'))],
			['b.txt', mockFileHandle('b.txt', enc.encode('bbb'))],
		]);
		const paths: string[] = [];
		for await (const { path } of TarArchiver.walkDirectory(dir)) paths.push(path);
		expect(paths).toEqual(['a.txt', 'b.txt']);
	});

	test('walkDirectory yields nested paths with prefix', async () => {
		const subdir = mockDir([
			['c.txt', mockFileHandle('c.txt', enc.encode('ccc'))],
		]);
		const dir = mockDir([
			['sub', subdir as unknown as FileSystemHandle],
		]);
		const paths: string[] = [];
		for await (const { path } of TarArchiver.walkDirectory(dir)) paths.push(path);
		expect(paths).toEqual(['sub/c.txt']);
	});

	test('create() produces a valid tar stream', async () => {
		const content = enc.encode('hello world');
		const dir = mockDir([
			['hello.txt', mockFileHandle('hello.txt', content)],
		]);
		const archiver = await TarArchiver.create(dir);
		const buf = await streamToBuffer(archiver.stream);

		const entries = parseTar(buf);
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe('hello.txt');
		expect(entries[0].size).toBe(content.length);
		expect(entries[0].data).toEqual(content);
	});

	test('create() index has correct offset and size', async () => {
		const content = enc.encode('hello world');
		const dir = mockDir([
			['hello.txt', mockFileHandle('hello.txt', content)],
		]);
		const archiver = await TarArchiver.create(dir);
		await streamToBuffer(archiver.stream);
		const index = await archiver.index;

		expect(index).toHaveLength(1);
		expect(index[0].path).toBe('hello.txt');
		expect(index[0].size).toBe(content.length);
		// Data starts after the 512-byte header
		expect(index[0].offset).toBe(512);
	});

	test('create() multi-file: stream and index cover all files', async () => {
		const files = [
			{ name: 'a.txt', content: enc.encode('aaaa') },
			{ name: 'b.txt', content: enc.encode('bbbbbb') },
		];
		const dir = mockDir(files.map(f => [f.name, mockFileHandle(f.name, f.content)]));
		const archiver = await TarArchiver.create(dir);
		const buf = await streamToBuffer(archiver.stream);
		const index = await archiver.index;

		const entries = parseTar(buf);
		expect(entries).toHaveLength(2);
		for (const [i, f] of files.entries()) {
			expect(entries[i].path).toBe(f.name);
			expect(entries[i].data).toEqual(f.content);
			// Verify index offset points to the correct data
			expect(buf.slice(index[i].offset, index[i].offset + f.content.length)).toEqual(f.content);
		}
	});

	test('create() nested directory: paths are prefixed correctly', async () => {
		const content = enc.encode('nested');
		const subdir = mockDir([['c.txt', mockFileHandle('c.txt', content)]]);
		const dir = mockDir([['sub', subdir as unknown as FileSystemHandle]]);
		const archiver = await TarArchiver.create(dir);
		const buf = await streamToBuffer(archiver.stream);
		const index = await archiver.index;

		const entries = parseTar(buf);
		expect(entries[0].path).toBe('sub/c.txt');
		expect(index[0].path).toBe('sub/c.txt');
	});
});

// ---- BgzfTarArchiver ----

describe('BgzfTarArchiver', () => {
	test('create() emits valid BGZF blocks ending with an EOF marker', async () => {
		const dir = mockDir([
			['test.txt', mockFileHandle('test.txt', enc.encode('bgzf test'))],
		]);
		const archiver = await BgzfTarArchiver.create(dir);
		const buf = await streamToBuffer(archiver.stream);

		// Walk all blocks to verify structure
		let offset = 0;
		let lastIsize = -1;
		while (offset < buf.length) {
			const { blockSize, isize } = parseBgzfBlock(buf, offset);
			expect(blockSize).toBeGreaterThan(0);
			expect(blockSize).toBeLessThanOrEqual(65536);
			lastIsize = isize;
			offset += blockSize;
		}
		// Last block must be the EOF marker
		expect(lastIsize).toBe(0);
		// All bytes consumed
		expect(offset).toBe(buf.length);
	});

	test('decompressing the stream and parsing as tar yields the original files', async () => {
		const files = [
			{ name: 'x.txt', content: enc.encode('content X') },
			{ name: 'y.txt', content: enc.encode('content Y longer') },
		];
		const dir = mockDir(files.map(f => [f.name, mockFileHandle(f.name, f.content)]));
		const archiver = await BgzfTarArchiver.create(dir);
		const buf = await streamToBuffer(archiver.stream);

		const tarData = await decompressBgzf(buf);
		const entries = parseTar(tarData);

		expect(entries).toHaveLength(2);
		for (const [i, f] of files.entries()) {
			expect(entries[i].path).toBe(f.name);
			expect(entries[i].data).toEqual(f.content);
		}
	});

	test('index is resolved after stream consumption and has one entry per file', async () => {
		const files = [
			{ name: 'p.txt', content: enc.encode('ppp') },
			{ name: 'q.txt', content: enc.encode('qqq') },
		];
		const dir = mockDir(files.map(f => [f.name, mockFileHandle(f.name, f.content)]));
		const archiver = await BgzfTarArchiver.create(dir);
		await streamToBuffer(archiver.stream); // consume stream to resolve index
		const index = await archiver.index;

		expect(index).toHaveLength(2);
		for (const [i, f] of files.entries()) {
			expect(index[i].path).toBe(f.name);
			expect(index[i].mimeType).toBe('application/octet-stream');
			// First block and last block are valid, non-empty ranges
			expect(index[i].aStart).toBeLessThan(index[i].aFirstEnd);
			expect(index[i].aFinalStart).toBeLessThan(index[i].aEnd);
			// When a file fits in one block, aStart==aFinalStart and aFirstEnd==aEnd
			expect(index[i].aStart).toBeLessThanOrEqual(index[i].aFinalStart);
			expect(index[i].rStartOffset).toBeGreaterThanOrEqual(0);
			expect(index[i].rEndOffset).toBeGreaterThanOrEqual(0);
		}
	});

	test('index block offsets point to the file data within the compressed stream', async () => {
		const content = enc.encode('findme in bgzf');
		const dir = mockDir([['findme.txt', mockFileHandle('findme.txt', content)]]);
		const archiver = await BgzfTarArchiver.create(dir);
		const buf = await streamToBuffer(archiver.stream);
		const [entry] = await archiver.index;

		// Decompress from aFinalStart (the block containing the file data end)
		const { cdata } = parseBgzfBlock(buf, entry.aFinalStart);
		const blockData = await decompressRaw(cdata);
		// The file data ends at blockData.length - rEndOffset
		const dataEnd = blockData.length - entry.rEndOffset;

		// The content must appear just before rEndOffset within this block
		const extracted = blockData.slice(dataEnd - content.length, dataEnd);
		expect(extracted).toEqual(content);
	});
});
