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

/** Check BGZF magic: FLG=FEXTRA (0x04), BC subfield (0x42, 0x43). */
export function isBgzf(bytes: Uint8Array): boolean {
	return bytes.length >= 18
		&& bytes[0] === 0x1f && bytes[1] === 0x8b
		&& bytes[3] === 0x04
		&& bytes[12] === 0x42 && bytes[13] === 0x43;
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

				if (isize === 0) return;

				controller.enqueue(await decompressDeflateRaw(deflateData as Uint8Array<ArrayBuffer>));
			}
		},
		flush(controller) {
			if (buf.length > 0) controller.error(new Error('Truncated BGZF block'));
		},
	});
}

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

async function compressDeflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
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

function storeDeflateRaw(data: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(5 + data.length);
	out[0] = 0x01;
	out[1] = data.length & 0xff;
	out[2] = (data.length >> 8) & 0xff;
	const nlen = (~data.length) & 0xffff;
	out[3] = nlen & 0xff;
	out[4] = (nlen >> 8) & 0xff;
	out.set(data, 5);
	return out;
}

const BGZF_OVERHEAD = 26;

export async function createBgzfBlock(uncompressed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	let deflated = await compressDeflate(uncompressed);
	const crc32 = calculateCrc32(uncompressed);

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

