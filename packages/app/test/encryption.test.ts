/*
 * SPDX-FileCopyrightText: tamaina / syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect } from 'vitest';
import { base58btc } from 'multiformats/bases/base58';
import {
	varintEncode,
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
		const wrongMultibase = base58btc.encode(combined);
		expect(multibaseToKey(wrongMultibase)).toBeNull();
	});

	test('wrong key length returns null', () => {
		const shortKey = new Uint8Array(16);
		const prefix = varintEncode(0x1550);
		const combined = new Uint8Array(prefix.length + shortKey.length);
		combined.set(prefix);
		combined.set(shortKey, prefix.length);
		const shortMultibase = base58btc.encode(combined);
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

describe('AES-CTR decrypt buffer limit', () => {
	test('errors when buffer exceeds maxBufferBytes persistently', async () => {
		const rawKey = generateRawKey();
		const iv = generateIv();
		const encKey = await importAesCtrKey(rawKey, ['encrypt']);
		const decKey = await importAesCtrKey(rawKey, ['decrypt']);

		const plaintext = crypto.getRandomValues(new Uint8Array(200));
		const encrypted = await encryptBlob(new Blob([plaintext]), encKey, iv);
		const encryptedData = new Uint8Array(await encrypted.arrayBuffer());
		const ciphertext = encryptedData.slice(AES_CTR_IV_LENGTH);

		// Use a tiny buffer-limit (2 bytes) and feed 3-byte chunks.
		// Since 3-byte chunks never reach 16-byte alignment, the buffer grows
		// without being processed: 3 → warn1, 6 → warn2, 9 → warn3, 12 → warn4 → error.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(iv.slice());
				for (let i = 0; i < ciphertext.length; i += 3) {
					controller.enqueue(ciphertext.slice(i, Math.min(i + 3, ciphertext.length)));
				}
				controller.close();
			},
		});

		const reader = stream.pipeThrough(createAesCtrDecryptTransform(decKey, 2)).getReader();
		await expect(async () => {
			while (true) {
				const { done } = await reader.read();
				if (done) break;
			}
		}).rejects.toThrow(/buffer exceeded/i);
	});

	test('succeeds with default buffer limit for normal data', async () => {
		const rawKey = generateRawKey();
		const iv = generateIv();
		const encKey = await importAesCtrKey(rawKey, ['encrypt']);
		const decKey = await importAesCtrKey(rawKey, ['decrypt']);

		const plaintext = crypto.getRandomValues(new Uint8Array(500));
		const encrypted = await encryptBlob(new Blob([plaintext]), encKey, iv);
		const encryptedData = new Uint8Array(await encrypted.arrayBuffer());

		// Feed in moderate chunks (64 bytes) — well within default 1MB limit
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < encryptedData.length; i += 64) {
					controller.enqueue(encryptedData.slice(i, Math.min(i + 64, encryptedData.length)));
				}
				controller.close();
			},
		});

		const chunks: Uint8Array[] = [];
		const reader = stream.pipeThrough(createAesCtrDecryptTransform(decKey)).getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		const total = chunks.reduce((sum, c) => sum + c.length, 0);
		const result = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		expect(result).toEqual(plaintext);
	});
});
