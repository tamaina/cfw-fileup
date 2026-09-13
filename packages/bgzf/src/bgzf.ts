/** Check the canonical BGZF header emitted by this package. */
export function isBgzf(bytes: Uint8Array): boolean {
	return bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b
		&& bytes[2] === 8 && bytes[3] === 4 && bytes[10] === 6 && bytes[11] === 0
		&& bytes[12] === 0x42 && bytes[13] === 0x43 && bytes[14] === 2 && bytes[15] === 0;
}

export function bgzfOutputSize(block: Uint8Array): number {
	if (!isBgzf(block)) throw new Error('Invalid BGZF header');
	const size = (block[16] | (block[17] << 8)) + 1;
	if (size < 28 || block.length !== size) throw new Error('Invalid BGZF block size');
	const output = new DataView(block.buffer, block.byteOffset + size - 4, 4).getUint32(0, true);
	if (output > 65536) throw new Error('Invalid BGZF output size');
	return output;
}

/** Views are valid until the caller transfers their parent buffer. Only carry is copied. */
export class BgzfBlockDecoder {
	private carry = new Uint8Array(65536);
	private carryLength = 0;
	*push(chunk: Uint8Array<ArrayBuffer>): Generator<Uint8Array<ArrayBuffer>> {
		let offset = 0;
		while (offset < chunk.length) {
			if (this.carryLength > 0) {
				const target = this.carryLength < 18 ? 18 : (this.carry[16] | (this.carry[17] << 8)) + 1;
				const take = Math.min(target - this.carryLength, chunk.length - offset);
				this.carry.set(chunk.subarray(offset, offset + take), this.carryLength);
				this.carryLength += take;
				offset += take;
				if (this.carryLength < 18) break;
				if (!isBgzf(this.carry)) throw new Error('Invalid BGZF header');
				const size = (this.carry[16] | (this.carry[17] << 8)) + 1;
				if (size < 28) throw new Error('Invalid BGZF block size');
				if (this.carryLength < size) continue;
				const block = this.carry.subarray(0, size);
				this.carry = new Uint8Array(65536);
				this.carryLength = 0;
				bgzfOutputSize(block);
				yield block;
				continue;
			}
			if (chunk.length - offset < 18) break;
			const rest = chunk.subarray(offset);
			if (!isBgzf(rest)) throw new Error('Invalid BGZF header');
			const size = (rest[16] | (rest[17] << 8)) + 1;
			if (size < 28) throw new Error('Invalid BGZF block size');
			if (rest.length < size) break;
			const block = rest.subarray(0, size);
			bgzfOutputSize(block);
			offset += size;
			yield block;
		}
		if (offset < chunk.length) {
			this.carry.set(chunk.subarray(offset));
			this.carryLength = chunk.length - offset;
		}
	}
	finish(): void {
		if (this.carryLength) throw new Error('Truncated BGZF block');
	}
}

/** gzip decoding validates CRC and ISIZE; enforce the output limit while reading too. */
export async function decompressBgzfBlock(block: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const size = bgzfOutputSize(block);
	const output = new Uint8Array(size);
	const stream = new Blob([block]).stream().pipeThrough(new DecompressionStream('gzip'));
	const reader = stream.getReader();
	let offset = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (offset + value.length > size) throw new Error('BGZF output exceeded ISIZE');
			output.set(value, offset);
			offset += value.length;
		}
		if (offset !== size) throw new Error('BGZF output size mismatch');
		return output;
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

export function createBgzfDecompressor(): TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
	const decoder = new BgzfBlockDecoder();
	return new TransformStream({
		async transform(chunk, controller) {
			for (const block of decoder.push(chunk)) {
				const output = await decompressBgzfBlock(block);
				if (output.length) controller.enqueue(output);
			}
		},
		flush() { decoder.finish(); },
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

