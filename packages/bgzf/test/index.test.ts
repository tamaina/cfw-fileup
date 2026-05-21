import { describe, test, expect } from 'vitest';
import { createBgzfBlock, createBgzfDecompressor, createTarHeader, parseTarStream, TarArchiver, BgzfTarArchiver } from '../src/index';

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

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

async function parseTar(buf: Uint8Array): Promise<TarEntry[]> {
	const entries: TarEntry[] = [];
	for await (const entry of parseTarStream(streamFromChunks([buf]))) {
		entries.push({ path: entry.name, size: entry.size, data: await streamToBuffer(entry.stream) });
	}
	return entries;
}

function makeTar(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function tarFile(name: string, content: Uint8Array): Uint8Array[] {
	return [
		createTarHeader(name, content.byteLength, 0),
		content,
		new Uint8Array((512 - (content.byteLength % 512)) % 512),
	];
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

// ---- createTarHeader ----

describe('createTarHeader', () => {
	test('is publicly exported and returns a 512-byte ustar file header', () => {
		const header = createTarHeader('folder/file.txt', 12, 1_700_000_000_000);
		const text = new TextDecoder();
		expect(header).toHaveLength(512);
		expect(text.decode(header.subarray(0, 100)).replace(/\0.*$/, '')).toBe('folder/file.txt');
		expect(parseInt(text.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim(), 8)).toBe(12);
		expect(header[156]).toBe('0'.charCodeAt(0));
		expect(text.decode(header.subarray(257, 262))).toBe('ustar');
		const stored = parseInt(text.decode(header.subarray(148, 154)).trim(), 8);
		const checksumHeader = header.slice();
		checksumHeader.fill(32, 148, 156);
		expect(stored).toBe(checksumHeader.reduce((sum, byte) => sum + byte, 0));
	});

	test('returns a directory header with directory mode and typeflag', () => {
		const header = createTarHeader('folder/', 0, 0, '5');
		const text = new TextDecoder();
		expect(text.decode(header.subarray(100, 108)).replace(/\0.*$/, '')).toBe('0000755');
		expect(header[156]).toBe('5'.charCodeAt(0));
	});
});

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

		const entries = await parseTar(buf);
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe('hello.txt');
		expect(entries[0].size).toBe(content.length);
		expect(entries[0].data).toEqual(content);
	});

	test('createFromEntries() produces a valid tar stream', async () => {
		const content = enc.encode('entry api');
		const archiver = await TarArchiver.createFromEntries([
			{ path: 'folder/entry.txt', file: new File([content], 'entry.txt') },
		]);
		const buf = await streamToBuffer(archiver.stream);
		const index = await archiver.index;

		const entries = await parseTar(buf);
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe('folder/entry.txt');
		expect(entries[0].data).toEqual(content);
		expect(index[0].path).toBe('folder/entry.txt');
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

		const entries = await parseTar(buf);
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

		const entries = await parseTar(buf);
		expect(entries[0].path).toBe('sub/c.txt');
		expect(index[0].path).toBe('sub/c.txt');
	});
});

// ---- Streaming tar parser ----

describe('parseTarStream', () => {
	test('yields regular files incrementally and skips directories', async () => {
		const first = enc.encode('first');
		const second = enc.encode('second file');
		const tar = makeTar([
			createTarHeader('dir/', 0, 0, '5'),
			...tarFile('dir/a.txt', first),
			...tarFile('b.txt', second),
			new Uint8Array(1024),
		]);

		const parsed: TarEntry[] = [];
		for await (const entry of parseTarStream(streamFromChunks([tar.subarray(0, 777), tar.subarray(777)]))) {
			parsed.push({ path: entry.name, size: entry.size, data: await streamToBuffer(entry.stream) });
		}

		expect(parsed.map(entry => entry.path)).toEqual(['dir/a.txt', 'b.txt']);
		expect(parsed[0].data).toEqual(first);
		expect(parsed[1].data).toEqual(second);
	});

	test('stops on zero block', async () => {
		const tar = makeTar([
			...tarFile('a.txt', enc.encode('a')),
			new Uint8Array(1024),
			...tarFile('ignored.txt', enc.encode('ignored')),
		]);

		const entries = await parseTar(tar);
		expect(entries.map(entry => entry.path)).toEqual(['a.txt']);
	});

	test('throws on truncated header or body', async () => {
		await expect(async () => {
			for await (const _entry of parseTarStream(streamFromChunks([new Uint8Array(100)]))) {
				// consume
			}
		}).rejects.toThrow('Truncated tar stream');

		const tar = makeTar([createTarHeader('bad.txt', 10, 0), enc.encode('short')]);
		await expect(async () => {
			for await (const entry of parseTarStream(streamFromChunks([tar]))) {
				await streamToBuffer(entry.stream);
			}
		}).rejects.toThrow('Truncated tar');
	});

	test('reads GNU tar base-256 size', async () => {
		const content = enc.encode('base256');
		const header = createTarHeader('base.bin', 0, 0);
		header.fill(0, 124, 136);
		header[124] = 0x80;
		header[135] = content.byteLength;
		header.fill(32, 148, 156);
		const checksum = header.reduce((sum, byte) => sum + byte, 0);
		const checksumBytes = enc.encode(checksum.toString(8).padStart(6, '0'));
		header.set(checksumBytes, 148);
		header[154] = 0;
		header[155] = 32;

		const entries = await parseTar(makeTar([
			header,
			content,
			new Uint8Array((512 - (content.byteLength % 512)) % 512),
			new Uint8Array(1024),
		]));
		expect(entries[0].size).toBe(content.byteLength);
		expect(entries[0].data).toEqual(content);
	});

	test('entry body stream can be read in chunks without buffering the full tar', async () => {
		const content = new Uint8Array(150_000).fill(0x61);
		const tar = makeTar([...tarFile('large.txt', content), new Uint8Array(1024)]);
		const iterator = parseTarStream(streamFromChunks([
			tar.subarray(0, 512),
			tar.subarray(512, 70_000),
			tar.subarray(70_000),
		]))[Symbol.asyncIterator]();
		const { value: entry } = await iterator.next();
		expect(entry?.name).toBe('large.txt');
		const reader = entry!.stream.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(first.value!.byteLength).toBeLessThan(content.byteLength);
		reader.releaseLock();
		await streamToBuffer(entry!.stream);
		await iterator.next();
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
		const entries = await parseTar(tarData);

		expect(entries).toHaveLength(2);
		for (const [i, f] of files.entries()) {
			expect(entries[i].path).toBe(f.name);
			expect(entries[i].data).toEqual(f.content);
		}
	});

	test('createBgzfDecompressor output can be parsed as tar and matches the index', async () => {
		const files = [
			{ path: 'one.txt', content: enc.encode('one') },
			{ path: 'two.txt', content: enc.encode('two two') },
		];
		const archiver = await BgzfTarArchiver.createFromEntries(files.map(file => ({
			path: file.path,
			file: new File([file.content], file.path),
		})));
		const decompressed = archiver.stream.pipeThrough(createBgzfDecompressor());
		const entries: TarEntry[] = [];
		for await (const entry of parseTarStream(decompressed)) {
			entries.push({ path: entry.name, size: entry.size, data: await streamToBuffer(entry.stream) });
		}
		const index = await archiver.index;

		expect(entries.map(entry => [entry.path, entry.size])).toEqual(files.map(file => [file.path, file.content.byteLength]));
		expect(index.map(entry => [entry.path, entry.rStartOffset >= 0])).toEqual(files.map(file => [file.path, true]));
	});

	test('createFromEntries() emits a BGZF tar stream', async () => {
		const content = enc.encode('entry bgzf');
		const archiver = await BgzfTarArchiver.createFromEntries([
			{ path: 'folder/entry.txt', file: new File([content], 'entry.txt') },
		]);
		const buf = await streamToBuffer(archiver.stream);
		const index = await archiver.index;
		const entries = await parseTar(await decompressBgzf(buf));

		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe('folder/entry.txt');
		expect(entries[0].data).toEqual(content);
		expect(index[0].path).toBe('folder/entry.txt');
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
