/**
 * Minimal streaming tar parser (ustar/POSIX format).
 *
 * Yields entries as { name, size, stream } where stream is the raw file data
 * bytes (not padded). Directory entries (name ending in '/') are skipped.
 *
 * Design notes:
 * - We operate on a byte-level buffer fed by a ReadableStream.
 * - Each tar block is 512 bytes. A file header occupies one block.
 * - File data follows, padded to a 512-byte boundary.
 * - Two consecutive zero-filled 512-byte blocks mark end-of-archive.
 */

const BLOCK = 512;
const dec = new TextDecoder();

function readOctal(buf: Uint8Array, offset: number, len: number): number {
	const str = dec.decode(buf.subarray(offset, offset + len)).replace(/\0/g, '').trim();
	return str ? parseInt(str, 8) : 0;
}

function readString(buf: Uint8Array, offset: number, len: number): string {
	const sub = buf.subarray(offset, offset + len);
	const nul = sub.indexOf(0);
	return dec.decode(nul >= 0 ? sub.subarray(0, nul) : sub);
}

export interface TarEntry {
	name: string;
	size: number;
	/** Raw (uncompressed) file data stream */
	stream: ReadableStream<Uint8Array<ArrayBuffer>>;
}

/**
 * Parse a ReadableStream of tar bytes and yield individual file entries.
 *
 * Caller must consume (or cancel) each entry.stream before the generator
 * yields the next entry — the underlying reader is shared.
 */
export async function* parseTar(
	input: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<TarEntry> {
	const reader = input.getReader();
	// Accumulate bytes as we need them
	let buf = new Uint8Array(0);
	let done = false;

	async function readBytes(n: number): Promise<Uint8Array<ArrayBuffer> | null> {
		while (buf.length < n) {
			if (done) return null;
			const { value, done: d } = await reader.read();
			done = d;
			if (value) {
				const next = new Uint8Array(buf.length + value.length);
				next.set(buf);
				next.set(value, buf.length);
				buf = next;
			}
		}
		const out = buf.slice(0, n) as Uint8Array<ArrayBuffer>;
		buf = buf.slice(n);
		return out;
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		while (true) {
			// Read header block
			const header = await readBytes(BLOCK);
			if (!header) break;

			// Two zero blocks = end of archive
			if (header.every(b => b === 0)) {
				await readBytes(BLOCK); // consume second zero block (best-effort)
				break;
			}

			const name = readString(header, 0, 100);
			const prefix = readString(header, 345, 155);
			const fullName = prefix ? `${prefix}/${name}` : name;
			const size = readOctal(header, 124, 12);
			const typeFlag = String.fromCharCode(header[156]);

			// Skip directories and special entries
			if (typeFlag === '5' || typeFlag === 'L' || typeFlag === 'K' || fullName.endsWith('/')) {
				// Skip data blocks
				const padded = Math.ceil(size / BLOCK) * BLOCK;
				if (padded > 0) await readBytes(padded);
				continue;
			}

			// Yield a stream for the file data
			let bytesRemaining = size;
			const paddingBytes = (BLOCK - (size % BLOCK)) % BLOCK;

			const fileStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
				async pull(controller) {
					if (bytesRemaining <= 0) {
						// Consume padding
						if (paddingBytes > 0) await readBytes(paddingBytes);
						controller.close();
						return;
					}
					const chunk = await readBytes(Math.min(bytesRemaining, 65536));
					if (!chunk) {
						controller.close();
						return;
					}
					bytesRemaining -= chunk.length;
					controller.enqueue(chunk);
				},
				cancel() {
					// Drain remaining bytes so the outer reader stays in sync
					const toSkip = bytesRemaining + paddingBytes;
					bytesRemaining = 0;
					if (toSkip > 0) {
						// Fire-and-forget (best effort)
						readBytes(toSkip).catch(() => {});
					}
				},
			});

			yield { name: fullName, size, stream: fileStream };

			// Ensure the stream is fully consumed before continuing
			// (consumer should have drained it, but guard in case)
			if (bytesRemaining > 0) {
				const toSkip = bytesRemaining + paddingBytes;
				await readBytes(toSkip);
			}
		}
	} finally {
		reader.releaseLock();
	}
}
