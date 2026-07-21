/**
 * Client-side E2E encryption utilities.
 *
 * Key format: multibase (base58btc) encoding of [multicodec varint || raw AES-256 key].
 * Encrypted data format: [IV (16 bytes) || AES-256-CTR ciphertext].
 *
 * AES-256-CTR is used (not GCM) to allow random-access decryption via byte-offset seeking.
 * The counter is a 128-bit big-endian integer starting from the IV, incremented per 16-byte block.
 */

import { ENCRYPTION_KEY_MULTICODEC } from './const';
import { base58btc } from 'multiformats/bases/base58';

// --- unsigned varint (protobuf/multicodec style) ---

/**
 * Encode a non-negative integer as an unsigned varint.
 * NOTE: Uses `>>>` (unsigned right shift), which operates on 32-bit integers.
 * Values must be in the range [0, 2^32 - 1]. For multicodec codes this is sufficient.
 */
export function varintEncode(value: number): Uint8Array<ArrayBuffer> {
	const bytes: number[] = [];
	while (value >= 0x80) {
		bytes.push((value & 0x7f) | 0x80);
		value >>>= 7;
	}
	bytes.push(value);
	return new Uint8Array(bytes);
}

export function varintDecode(bytes: Uint8Array, offset = 0): { value: number; length: number } {
	let value = 0;
	let shift = 0;
	let length = 0;
	for (let i = offset; i < bytes.length; i++) {
		const byte = bytes[i]!;
		value |= (byte & 0x7f) << shift;
		length++;
		if ((byte & 0x80) === 0) break;
		shift += 7;
	}
	return { value, length };
}

// --- Key multibase encoding/decoding ---

/**
 * Encode a raw 32-byte AES-256 key as a multibase string (base58btc with 'z' prefix).
 * Format: 'z' + base58btc(varint(multicodec) || rawKey)
 */
export function keyToMultibase(rawKey: Uint8Array): string {
	const prefix = varintEncode(ENCRYPTION_KEY_MULTICODEC);
	const combined = new Uint8Array(prefix.length + rawKey.length);
	combined.set(prefix);
	combined.set(rawKey, prefix.length);
	return base58btc.encode(combined);
}

/**
 * Decode a multibase string back to a raw 32-byte AES-256 key.
 * Returns null if the format is invalid.
 */
export function multibaseToKey(multibase: string): Uint8Array<ArrayBuffer> | null {
	try {
		if (!multibase.startsWith('z')) return null;
		const decoded = base58btc.decode(multibase);
		const { value: codec, length: prefixLen } = varintDecode(decoded);
		if (codec !== ENCRYPTION_KEY_MULTICODEC) return null;
		const key = decoded.slice(prefixLen);
		if (key.length !== 32) return null;
		return key;
	} catch {
		return null;
	}
}

// --- AES-256-CTR crypto ---

export const AES_CTR_IV_LENGTH = 16;
export const AES_CTR_KEY_LENGTH = 32;
const AES_CTR_COUNTER_BITS = 128;

/**
 * Generate a random 32-byte AES-256 key.
 */
export function generateRawKey(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(AES_CTR_KEY_LENGTH));
}

/**
 * Generate a random 16-byte IV for AES-CTR.
 */
export function generateIv(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(AES_CTR_IV_LENGTH));
}

/**
 * Import raw key bytes as a CryptoKey for AES-CTR operations.
 */
export async function importAesCtrKey(rawKey: Uint8Array<ArrayBuffer>, usages: KeyUsage[] = ['encrypt', 'decrypt']): Promise<CryptoKey> {
	return await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CTR' }, false, usages);
}

/**
 * Compute the counter block for a given byte offset.
 * counter = IV + floor(byteOffset / 16) as a 128-bit big-endian integer.
 *
 * The addition is performed byte-by-byte from the least significant byte (index 15)
 * upwards. `carry` holds the remaining value to add: initially the block index,
 * then any overflow propagated to higher bytes. At each byte position:
 *   - Add the low byte of `carry` to the counter byte.
 *   - If the sum exceeds 0xff, propagate +1 to the next higher byte.
 *   - Shift `carry` right by 8 bits (divide by 256) for the next iteration.
 * Both sources of carry (block index upper bytes AND byte overflow) are combined.
 */
function computeCounter(iv: Uint8Array, byteOffset: number): Uint8Array<ArrayBuffer> {
	const counter = new Uint8Array(iv);
	const blockIndex = Math.floor(byteOffset / 16);
	let carry = blockIndex;
	for (let i = 15; i >= 0 && carry > 0; i--) {
		const sum = counter[i]! + (carry & 0xff);
		counter[i] = sum & 0xff;
		// Propagate: upper bytes of carry + overflow from this byte addition
		carry = Math.floor(carry / 256) + (sum > 0xff ? 1 : 0);
	}
	return counter;
}

/**
 * Create a TransformStream that encrypts data with AES-256-CTR.
 * Prepends the IV (16 bytes) to the output stream.
 */
export function createAesCtrEncryptTransform(key: CryptoKey, iv: Uint8Array<ArrayBuffer>): TransformStream<Uint8Array, Uint8Array> {
	let ivSent = false;
	let buffer = new Uint8Array(0);
	let bytesProcessed = 0;

	return new TransformStream<Uint8Array, Uint8Array>({
		async transform(chunk, controller) {
			if (!ivSent) {
				controller.enqueue(iv.slice());
				ivSent = true;
			}

			// Append chunk to buffer
			const next = new Uint8Array(buffer.length + chunk.length);
			next.set(buffer);
			next.set(chunk, buffer.length);
			buffer = next;

			// Encrypt all complete 16-byte blocks
			const alignedLength = buffer.length - (buffer.length % 16);
			if (alignedLength > 0) {
				const counter = computeCounter(iv, bytesProcessed);
				const encrypted = await crypto.subtle.encrypt(
					{ name: 'AES-CTR', counter, length: AES_CTR_COUNTER_BITS },
					key,
					buffer.slice(0, alignedLength),
				);
				controller.enqueue(new Uint8Array(encrypted));
				buffer = buffer.slice(alignedLength);
				bytesProcessed += alignedLength;
			}
		},
		async flush(controller) {
			if (!ivSent) {
				controller.enqueue(iv.slice());
			}
			if (buffer.length > 0) {
				const counter = computeCounter(iv, bytesProcessed);
				const encrypted = await crypto.subtle.encrypt(
					{ name: 'AES-CTR', counter, length: AES_CTR_COUNTER_BITS },
					key,
					buffer,
				);
				controller.enqueue(new Uint8Array(encrypted));
			}
		},
	});
}

/** Default maximum buffer size for AES-CTR decrypt transform (1 MB). */
export const AES_CTR_DECRYPT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Create a TransformStream that decrypts AES-256-CTR data.
 * Expects the IV (16 bytes) at the beginning of the input stream.
 *
 * @param key - The AES-CTR CryptoKey for decryption.
 * @param maxBufferBytes - Maximum allowed buffer size before raising an error.
 *   Defaults to {@link AES_CTR_DECRYPT_MAX_BUFFER_BYTES} (1 MB).
 *   On very slow networks the unaligned remainder can accumulate; this limit
 *   prevents unbounded memory growth.
 */
export function createAesCtrDecryptTransform(
	key: CryptoKey,
	maxBufferBytes: number = AES_CTR_DECRYPT_MAX_BUFFER_BYTES,
): TransformStream<Uint8Array, Uint8Array> {
	let iv: Uint8Array | null = null;
	let buffer = new Uint8Array(0);
	let bytesProcessed = 0;
	let bufferWarningCount = 0;

	return new TransformStream<Uint8Array, Uint8Array>({
		async transform(chunk, controller) {
			// Accumulate until we have the IV
			if (!iv) {
				const next = new Uint8Array(buffer.length + chunk.length);
				next.set(buffer);
				next.set(chunk, buffer.length);
				buffer = next;

				if (buffer.length < AES_CTR_IV_LENGTH) return;

				iv = buffer.slice(0, AES_CTR_IV_LENGTH);
				buffer = buffer.slice(AES_CTR_IV_LENGTH);
			} else {
				const next = new Uint8Array(buffer.length + chunk.length);
				next.set(buffer);
				next.set(chunk, buffer.length);
				buffer = next;
			}

			// Monitor buffer size to prevent unbounded memory growth on slow networks
			if (buffer.length > maxBufferBytes) {
				bufferWarningCount++;
				if (bufferWarningCount > 3) {
					controller.error(new Error(
						`AES-CTR decrypt buffer exceeded ${maxBufferBytes} bytes (current: ${buffer.length}). `
						+ 'Network may be too slow or the server stopped sending data. Please try again.',
					));
					return;
				}
				console.warn(
					`[AES-CTR] Buffer size warning (${bufferWarningCount}/3): ${buffer.length} / ${maxBufferBytes} bytes. Network may be congested.`,
				);
			}

			// Decrypt all complete 16-byte blocks
			const alignedLength = buffer.length - (buffer.length % 16);
			if (alignedLength > 0) {
				const counter = computeCounter(iv, bytesProcessed);
				const decrypted = await crypto.subtle.decrypt(
					{ name: 'AES-CTR', counter, length: AES_CTR_COUNTER_BITS },
					key,
					buffer.slice(0, alignedLength),
				);
				controller.enqueue(new Uint8Array(decrypted));
				buffer = buffer.slice(alignedLength);
				bytesProcessed += alignedLength;
				// Reset warning count on successful progress
				bufferWarningCount = Math.max(0, bufferWarningCount - 1);
			}
		},
		async flush(controller) {
			if (buffer.length > 0 && iv) {
				const counter = computeCounter(iv, bytesProcessed);
				const decrypted = await crypto.subtle.decrypt(
					{ name: 'AES-CTR', counter, length: AES_CTR_COUNTER_BITS },
					key,
					buffer,
				);
				controller.enqueue(new Uint8Array(decrypted));
			}
		},
	});
}

/**
 * Encrypt a Blob with AES-256-CTR. Returns a new Blob with IV prepended.
 * Useful for small files where streaming is unnecessary.
 */
export async function encryptBlob(blob: Blob, key: CryptoKey, iv: Uint8Array<ArrayBuffer>): Promise<Blob> {
	const data = new Uint8Array(await blob.arrayBuffer());
	const counter = computeCounter(iv, 0);
	const encrypted = await crypto.subtle.encrypt(
		{ name: 'AES-CTR', counter, length: AES_CTR_COUNTER_BITS },
		key,
		data,
	);
	return new Blob([iv, encrypted], { type: 'application/octet-stream' });
}

/**
 * Decrypt a Blob that has IV prepended. Returns the decrypted Blob.
 */
export async function decryptBlob(blob: Blob, key: CryptoKey): Promise<Blob> {
	const data = new Uint8Array(await blob.arrayBuffer());
	if (data.length < AES_CTR_IV_LENGTH) throw new Error('Encrypted data too short');
	const iv = data.slice(0, AES_CTR_IV_LENGTH);
	const ciphertext = data.slice(AES_CTR_IV_LENGTH);
	const counter = computeCounter(iv, 0);
	const decrypted = await crypto.subtle.decrypt(
		{ name: 'AES-CTR', counter, length: AES_CTR_COUNTER_BITS },
		key,
		ciphertext,
	);
	return new Blob([decrypted], { type: blob.type });
}
