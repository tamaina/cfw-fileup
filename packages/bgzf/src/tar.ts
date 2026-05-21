const enc = new TextEncoder();
const dec = new TextDecoder();

function writeString(buf: Uint8Array, offset: number, str: string, maxLen: number): void {
	buf.set(enc.encode(str).slice(0, maxLen), offset);
}

function writeOctal(buf: Uint8Array, offset: number, value: number, len: number): void {
	writeString(buf, offset, value.toString(8).padStart(len - 1, '0'), len);
}

export function createTarHeader(name: string, size: number, mtime: number, type: '0' | '5' = '0'): Uint8Array<ArrayBuffer> {
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

export interface TarFileEntry {
	name: string;
	size: number;
	type: 'file';
	stream: ReadableStream<Uint8Array<ArrayBuffer>>;
}

interface TarHeader {
	name: string;
	size: number;
	typeflag: number;
}

function isZeroBlock(block: Uint8Array): boolean {
	return block.every(byte => byte === 0);
}

function parseString(block: Uint8Array, offset: number, length: number): string {
	return dec.decode(block.subarray(offset, offset + length)).replace(/\0.*$/, '');
}

function parseSize(block: Uint8Array): number {
	const field = block.subarray(124, 136);
	if ((field[0] & 0x80) !== 0) {
		let value = BigInt(field[0] & 0x7f);
		for (let i = 1; i < field.length; i++) value = (value << 8n) | BigInt(field[i]);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Tar entry size exceeds safe integer range');
		return Number(value);
	}
	const raw = dec.decode(field).replace(/\0.*$/, '').trim();
	return raw === '' ? 0 : parseInt(raw, 8);
}

function parseHeader(block: Uint8Array): TarHeader {
	const prefix = parseString(block, 345, 155);
	const name = parseString(block, 0, 100);
	return {
		name: prefix ? `${prefix}/${name}` : name,
		size: parseSize(block),
		typeflag: block[156] || 48,
	};
}

class TarStreamReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;
	private buffer = new Uint8Array(0);
	private done = false;

	constructor(stream: ReadableStream<Uint8Array<ArrayBuffer>>) {
		this.reader = stream.getReader();
	}

	async readExact(length: number): Promise<Uint8Array<ArrayBuffer> | null> {
		while (!this.done && this.buffer.length < length) {
			const { done, value } = await this.reader.read();
			if (done) {
				this.done = true;
				break;
			}
			if (value.byteLength === 0) continue;
			const merged = new Uint8Array(this.buffer.length + value.byteLength);
			merged.set(this.buffer);
			merged.set(value, this.buffer.length);
			this.buffer = merged;
		}
		if (this.buffer.length < length) {
			if (this.buffer.length === 0) return null;
			throw new Error('Truncated tar stream');
		}
		const out = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return out;
	}
}

function createEntryStream(reader: TarStreamReader, size: number): ReadableStream<Uint8Array<ArrayBuffer>> {
	let remaining = size;
	return new ReadableStream({
		async pull(controller) {
			if (remaining === 0) {
				controller.close();
				return;
			}
			const chunk = await reader.readExact(Math.min(remaining, 64 * 1024));
			if (chunk === null) {
				controller.error(new Error('Truncated tar entry body'));
				return;
			}
			remaining -= chunk.byteLength;
			controller.enqueue(chunk);
		},
	});
}

async function drain(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}

export async function* parseTarStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>): AsyncGenerator<TarFileEntry> {
	const reader = new TarStreamReader(stream);

	while (true) {
		const block = await reader.readExact(512);
		if (block === null) return;
		if (isZeroBlock(block)) return;

		const header = parseHeader(block);
		const padding = (512 - (header.size % 512)) % 512;
		const isRegularFile = header.typeflag === 0 || header.typeflag === 48;
		const body = createEntryStream(reader, header.size);

		if (isRegularFile) {
			yield { name: header.name, size: header.size, type: 'file', stream: body };
			await drain(body);
		} else {
			await drain(body);
		}

		if (padding > 0) {
			const pad = await reader.readExact(padding);
			if (pad === null) throw new Error('Truncated tar entry padding');
		}
	}
}

