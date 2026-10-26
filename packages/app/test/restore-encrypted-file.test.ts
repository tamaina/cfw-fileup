import { describe, test, expect } from 'vitest';
import {
	generateRawKey,
	generateIv,
	importAesCtrKey,
	keyToMultibase,
	encryptBlob,
	AES_CTR_IV_LENGTH,
} from '../src/shared/encryption.js';
import {
	EncryptedFileMismatchError,
	assertRestorableEncryptedFile,
	decryptedSizeOf,
	restoreEncryptedBlobToWritable,
	type RestoreProgress,
} from '../src/client/utils/restore-encrypted-file.js';

function collectingWritable(): { writable: WritableStream<Uint8Array>; bytes: () => Uint8Array; closed: () => boolean } {
	const chunks: Uint8Array[] = [];
	let isClosed = false;
	const writable = new WritableStream<Uint8Array>({
		write(chunk) { chunks.push(chunk.slice()); },
		close() { isClosed = true; },
	});
	return {
		writable,
		bytes: () => {
			const total = chunks.reduce((sum, c) => sum + c.length, 0);
			const out = new Uint8Array(total);
			let offset = 0;
			for (const c of chunks) { out.set(c, offset); offset += c.length; }
			return out;
		},
		closed: () => isClosed,
	};
}

async function encryptedFixture(size: number): Promise<{ plaintext: Uint8Array; encrypted: Blob; keyMultibase: string }> {
	const raw = generateRawKey();
	const key = await importAesCtrKey(raw);
	const plaintext = new Uint8Array(size);
	for (let i = 0; i < size; i++) plaintext[i] = (i * 31 + 7) & 0xff;
	const encrypted = await encryptBlob(new Blob([plaintext]), key, generateIv());
	return { plaintext, encrypted, keyMultibase: keyToMultibase(raw) };
}

describe('restoreEncryptedBlobToWritable', () => {
	test('restores an encrypted blob that is not block aligned', async () => {
		const { plaintext, encrypted, keyMultibase } = await encryptedFixture(100_003);
		const target = collectingWritable();
		const progress: RestoreProgress[] = [];
		await restoreEncryptedBlobToWritable(encrypted, keyMultibase, target.writable, p => progress.push(p));
		expect(target.bytes()).toEqual(plaintext);
		expect(target.closed()).toBe(true);
		expect(progress.at(-1)).toEqual({ completedBytes: encrypted.size, totalBytes: encrypted.size });
	});

	test('restores an empty file (IV only)', async () => {
		const { encrypted, keyMultibase } = await encryptedFixture(0);
		expect(encrypted.size).toBe(AES_CTR_IV_LENGTH);
		const target = collectingWritable();
		await restoreEncryptedBlobToWritable(encrypted, keyMultibase, target.writable);
		expect(target.bytes().length).toBe(0);
		expect(target.closed()).toBe(true);
	});

	test('rejects an invalid key without writing', async () => {
		const { encrypted } = await encryptedFixture(32);
		const target = collectingWritable();
		await expect(restoreEncryptedBlobToWritable(encrypted, 'not-a-key', target.writable)).rejects.toThrow();
		expect(target.bytes().length).toBe(0);
		expect(target.closed()).toBe(false);
	});
});

describe('assertRestorableEncryptedFile', () => {
	test('accepts a file whose size matches the stored encrypted size', () => {
		expect(() => assertRestorableEncryptedFile(1016, 1016)).not.toThrow();
	});

	test('accepts any size >= IV when the stored size is unknown', () => {
		expect(() => assertRestorableEncryptedFile(AES_CTR_IV_LENGTH, null)).not.toThrow();
	});

	test('rejects a size mismatch (wrong file selected)', () => {
		expect(() => assertRestorableEncryptedFile(1000, 1016)).toThrow(EncryptedFileMismatchError);
	});

	test('rejects files shorter than the IV', () => {
		expect(() => assertRestorableEncryptedFile(AES_CTR_IV_LENGTH - 1, undefined)).toThrow(EncryptedFileMismatchError);
	});
});

describe('decryptedSizeOf', () => {
	test('subtracts the IV length', () => {
		expect(decryptedSizeOf(1016)).toBe(1000);
		expect(decryptedSizeOf(3)).toBe(0);
	});
});
