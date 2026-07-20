/*
 * SPDX-FileCopyrightText: tamaina / syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect } from 'vitest';
import {
	base58btcEncode,
	base58btcDecode,
	varintEncode,
	varintDecode,
	keyToMultibase,
	multibaseToKey,
	generateRawKey,
	generateIv,
	importAesCtrKey,
	createAesCtrEncryptTransform,
	createAesCtrDecryptTransform,
	encryptBlob,
	decryptBlob,
	AES_CTR_IV_LENGTH,
	AES_CTR_KEY_LENGTH,
} from '../src/shared/encryption.js';

describe('base58btc', () => {
	test('encode/decode roundtrip', () => {
		const data = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
		const encoded = base58btcEncode(data);
		const decoded = base58btcDecode(encoded);
		expect(decoded).toEqual(data);
	});

	test('empty input', () => {
		expect(base58btcEncode(new Uint8Array(0))).toBe('');
		expect(base58btcDecode('')).toEqual(new Uint8Array(0));
	});

	test('leading zeros preserved', () => {
		const data = new Uint8Array([0, 0, 0, 42]);
		const encoded = base58btcEncode(data);
		expect(encoded.startsWith('111')).toBe(true);
		const decoded = base58btcDecode(encoded);
		expect(decoded).toEqual(data);
	});

	test('known vector: "Hello World"', () => {
		const data = new TextEncoder().encode('Hello World');
		const encoded = base58btcEncode(data);
		expect(encoded).toBe('JxF12TrwUP45BMd');
		const decoded = base58btcDecode(encoded);
		expect(new TextDecoder().decode(decoded)).toBe('Hello World');
	});

	test('invalid character throws', () => {
		expect(() => base58btcDecode('0OIl')).toThrow();
	});
});

describe('varint', () => {
	test('single byte value', () => {
		const encoded = varintEncode(0x50);
		expect(encoded).toEqual(new Uint8Array([0x50]));
		const { value, length } = varintDecode(encoded);
		expect(value).toBe(0x50);
		expect(length).toBe(1);
	});

	test('multi-byte value (0x1550)', () => {
		const encoded = varintEncode(0x1550);
		const { value, length } = varintDecode(encoded);
		expect(value).toBe(0x1550);
		expect(length).toBe(encoded.length);
	});

	test('roundtrip various values', () => {
		for (const v of [0, 1, 127, 128, 255, 256, 16383, 16384, 0x1550, 0xFFFF]) {
			const encoded = varintEncode(v);
			const { value } = varintDecode(encoded);
			expect(value).toBe(v);
		}
	});

	test('decode with offset', () => {
		const prefix = new Uint8Array([0xAA, 0xBB]);
		const varint = varintEncode(300);
		const combined = new Uint8Array([...prefix, ...varint]);
		const { value, length } = varintDecode(combined, 2);
		expect(value).toBe(300);
		expect(length).toBe(varint.length);
	});
});

describe('key multibase encoding', () => {
	test('roundtrip 32-byte key', () => {
		const key = generateRawKey();
		expect(key.length).toBe(AES_CTR_KEY_LENGTH);
		const multibase = keyToMultibase(key);
		expect(multibase.startsWith('z')).toBe(true);
		const decoded = multibaseToKey(multibase);
		expect(decoded).not.toBeNull();
		expect(decoded).toEqual(key);
	});

	test('invalid multibase returns null', () => {
		expect(multibaseToKey('')).toBeNull();
		expect(multibaseToKey('x123')).toBeNull();
		expect(multibaseToKey('z')).toBeNull();
		expect(multibaseToKey('zinvalid!!!')).toBeNull();
	});

	test('wrong codec returns null', () => {
		// Encode with a different codec
		const key = generateRawKey();
		const wrongPrefix = varintEncode(0x9999);
		const combined = new Uint8Array(wrongPrefix.length + key.length);
		combined.set(wrongPrefix);
		combined.set(key, wrongPrefix.length);
		const wrongMultibase = `z${base58btcEncode(combined)}`;
		expect(multibaseToKey(wrongMultibase)).toBeNull();
	});

	test('wrong key length returns null', () => {
		const shortKey = new Uint8Array(16);
		const prefix = varintEncode(0x1550);
		const combined = new Uint8Array(prefix.length + shortKey.length);
		combined.set(prefix);
		combined.set(shortKey, prefix.length);
		const shortMultibase = `z${base58btcEncode(combined)}`;
		expect(multibaseToKey(shortMultibase)).toBeNull();
	});
});

describe('AES-256-CTR encrypt/decrypt Blob', () => {
	test('roundtrip small data', async () => {
		const rawKey = generateRawKey();
		const iv = generateIv();
		const cryptoKey = await importAesCtrKey(rawKey, ['encrypt', 'decrypt']);

		const plaintext = new TextEncoder().encode('Hello, encryption!');
		const blob = new Blob([plaintext]);

		const encrypted = await encryptBlob(blob, cryptoKey, iv);
		const encryptedData = new Uint8Array(await encrypted.arrayBuffer());
		// IV prepended
		expect(encryptedData.length).toBe(AES_CTR_IV_LENGTH + plaintext.length);
		expect(encryptedData.slice(0, AES_CTR_IV_LENGTH)).toEqual(iv);

		const decrypted = await decryptBlob(encrypted, cryptoKey);
		const decryptedData = new Uint8Array(await decrypted.arrayBuffer());
		expect(decryptedData).toEqual(plaintext);
	});

	test('roundtrip empty data', async () => {
		const rawKey = generateRawKey();
		const iv = generateIv();
		const cryptoKey = await importAesCtrKey(rawKey, ['encrypt', 'decrypt']);

		const blob = new Blob([new Uint8Array(0)]);
		const encrypted = await encryptBlob(blob, cryptoKey, iv);
		const encryptedData = new Uint8Array(await encrypted.arrayBuffer());
		expect(encryptedData.length).toBe(AES_CTR_IV_LENGTH);

		const decrypted = await decryptBlob(encrypted, cryptoKey);
		const decryptedData = new Uint8Array(await decrypted.arrayBuffer());
		expect(decryptedData.length).toBe(0);
	});

	test('roundtrip large data (multi-block)', async () => {
		const rawKey = generateRawKey();
		const iv = generateIv();
		const cryptoKey = await importAesCtrKey(rawKey, ['encrypt', 'decrypt']);

		// 1000 bytes spans multiple 16-byte blocks
		const plaintext = crypto.getRandomValues(new Uint8Array(1000));
		const blob = new Blob([plaintext]);

		const encrypted = await encryptBlob(blob, cryptoKey, iv);
		const decrypted = await decryptBlob(encrypted, cryptoKey);
		const decryptedData = new Uint8Array(await decrypted.arrayBuffer());
		expect(decryptedData).toEqual(plaintext);
	});

	test('decrypt too-short data throws', async () => {
		const rawKey = generateRawKey();
		const cryptoKey = await importAesCtrKey(rawKey, ['decrypt']);
		const shortBlob = new Blob([new Uint8Array(10)]);
		await expect(decryptBlob(shortBlob, cryptoKey)).rejects.toThrow('too short');
	});
});

describe('AES-256-CTR streaming transforms', () => {
	test('encrypt/decrypt stream roundtrip', async () => {
		const rawKey = generateRawKey();
		const iv = generateIv();
		const encKey = await importAesCtrKey(rawKey, ['encrypt']);
		const decKey = await importAesCtrKey(rawKey, ['decrypt']);

		const plaintext = new TextEncoder().encode('Streaming encryption test with some data that spans multiple blocks for good measure.');

		// Encrypt
		const inputStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(plaintext);
				controller.close();
			},
		});
		const encryptedStream = inputStream.pipeThrough(createAesCtrEncryptTransform(encKey, iv));
		const encryptedChunks: Uint8Array[] = [];
		const encReader = encryptedStream.getReader();
		while (true) {
			const { done, value } = await encReader.read();
			if (done) break;
			encryptedChunks.push(value);
		}
		const encryptedTotal = encryptedChunks.reduce((sum, c) => sum + c.length, 0);
		expect(encryptedTotal).toBe(AES_CTR_IV_LENGTH + plaintext.length);

		// Decrypt
		const encryptedFull = new Uint8Array(encryptedTotal);
		let offset = 0;
		for (const chunk of encryptedChunks) {
			encryptedFull.set(chunk, offset);
			offset += chunk.length;
		}
		const decryptStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encryptedFull);
				controller.close();
			},
		});
		const decryptedStream = decryptStream.pipeThrough(createAesCtrDecryptTransform(decKey));
		const decryptedChunks: Uint8Array[] = [];
		const decReader = decryptedStream.getReader();
		while (true) {
			const { done, value } = await decReader.read();
			if (done) break;
			decryptedChunks.push(value);
		}
		const decryptedTotal = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
		const decryptedData = new Uint8Array(decryptedTotal);
		let dOffset = 0;
		for (const chunk of decryptedChunks) {
			decryptedData.set(chunk, dOffset);
			dOffset += chunk.length;
		}
		expect(decryptedData).toEqual(plaintext);
	});

	test('chunked input produces same result', async () => {
		const rawKey = generateRawKey();
		const iv = generateIv();
		const encKey = await importAesCtrKey(rawKey, ['encrypt']);
		const decKey = await importAesCtrKey(rawKey, ['decrypt']);

		const plaintext = crypto.getRandomValues(new Uint8Array(100));

		// Encrypt in small chunks (7 bytes each to test non-aligned)
		const chunks: Uint8Array[] = [];
		for (let i = 0; i < plaintext.length; i += 7) {
			chunks.push(plaintext.slice(i, Math.min(i + 7, plaintext.length)));
		}

		const inputStream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});
		const encryptedStream = inputStream.pipeThrough(createAesCtrEncryptTransform(encKey, iv));
		const encryptedChunks: Uint8Array[] = [];
		const encReader = encryptedStream.getReader();
		while (true) {
			const { done, value } = await encReader.read();
			if (done) break;
			encryptedChunks.push(value);
		}

		// Decrypt
		const encryptedTotal = encryptedChunks.reduce((sum, c) => sum + c.length, 0);
		const encryptedFull = new Uint8Array(encryptedTotal);
		let offset = 0;
		for (const chunk of encryptedChunks) {
			encryptedFull.set(chunk, offset);
			offset += chunk.length;
		}
		const decryptStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encryptedFull);
				controller.close();
			},
		});
		const decryptedStream = decryptStream.pipeThrough(createAesCtrDecryptTransform(decKey));
		const decryptedChunks: Uint8Array[] = [];
		const decReader = decryptedStream.getReader();
		while (true) {
			const { done, value } = await decReader.read();
			if (done) break;
			decryptedChunks.push(value);
		}
		const decryptedTotal = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
		const decryptedData = new Uint8Array(decryptedTotal);
		let dOffset = 0;
		for (const chunk of decryptedChunks) {
			decryptedData.set(chunk, dOffset);
			dOffset += chunk.length;
		}
		expect(decryptedData).toEqual(plaintext);
	});
});
