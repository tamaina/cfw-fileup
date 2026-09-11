import { expect, test } from 'vitest';
import { createTarHeader, parseTarStream } from 'bgzf';
import { createDecryptedTarStream } from '../src/client/workers/decrypted-tar';
import { encryptBlob, importAesCtrKey } from '../src/shared/encryption';

async function fixture(sizes: number[]) {
	const key = await importAesCtrKey(new Uint8Array(32).fill(7));
	const originals = sizes.map((size, i) => new Uint8Array(size).fill(i + 1));
	const parts: BlobPart[] = [];
	for (const [i, original] of originals.entries()) {
		const encrypted = await encryptBlob(new Blob([original]), key, new Uint8Array(16).fill(i));
		parts.push(createTarHeader(`${i}.MOV`, encrypted.size, 0), encrypted, new Uint8Array((512 - encrypted.size % 512) % 512));
	}
	parts.push(new Uint8Array(1024));
	return { key, originals, bytes: new Uint8Array(await new Blob(parts).arrayBuffer()) };
}

test('decrypts empty, unaligned and multiple entries with correct tar sizes and padding', async () => {
	const { key, originals, bytes } = await fixture([0, 31, 131073]);
	const output = createDecryptedTarStream(new Blob([bytes]).stream(), key, () => {}, () => {});
	let i = 0;
	for await (const entry of parseTarStream(output)) {
		expect(entry.name).toBe(`${i}.MOV`);
		expect(entry.size).toBe(originals[i].length);
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		for await (const chunk of entry.stream) chunks.push(chunk);
		expect(new Uint8Array(await new Blob(chunks).arrayBuffer())).toEqual(originals[i]);
		i++;
	}
	expect(i).toBe(originals.length);
});

test('produces decrypted bytes before reading an entire large entry and stops input on cancellation', async () => {
	const { key, bytes } = await fixture([1024 * 1024]);
	let offset = 0;
	let cancelled = false;
	const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
		pull(controller) {
			if (offset >= bytes.length) { controller.close(); return; }
			controller.enqueue(bytes.slice(offset, offset + 4096));
			offset += 4096;
		},
	});
	const reader = createDecryptedTarStream(source, key, () => {}, () => { cancelled = true; }).getReader();
	expect((await reader.read()).value?.length).toBe(512);
	expect((await reader.read()).value?.length).toBeGreaterThan(0);
	expect(offset).toBeLessThan(256 * 1024);
	await reader.cancel();
	expect(cancelled).toBe(true);
});

test('preserves the input error and entry name instead of a generic Blob AbortError', async () => {
	const { key, bytes } = await fixture([131072]);
	let first = true;
	const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
		pull(controller) {
			if (first) { first = false; controller.enqueue(bytes.slice(0, 66048)); } else controller.error(new TypeError('input disconnected'));
		},
	});
	const reader = createDecryptedTarStream(source, key, () => {}, () => {}).getReader();
	await expect((async () => {
		while (!(await reader.read()).done) { /* drain */ }
	})()).rejects.toThrow('Archive input/decryption failed (0.MOV): input disconnected');
});
