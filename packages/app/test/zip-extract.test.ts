import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, test } from 'vitest';
import { extractZipFile, normalizeZipEntryPath } from '../src/client/utils/zip-extract';

async function zipFile(name: string, entries: Array<{ path: string; text?: string; directory?: boolean }>, password?: string): Promise<File> {
	const writer = new ZipWriter(new BlobWriter('application/zip'));
	for (const entry of entries) {
		if (entry.directory) {
			await writer.add(entry.path, undefined, { directory: true });
		} else {
			await writer.add(entry.path, new TextReader(entry.text ?? entry.path), { password });
		}
	}
	const blob = await writer.close();
	return new File([blob], name, { type: 'application/zip', lastModified: 1 });
}

describe('zip extraction upload helper', () => {
	test('extracts non-encrypted zip entries below a root named from the zip', async () => {
		const archive = await zipFile('photos.zip', [
			{ path: 'a.txt', text: 'A' },
			{ path: 'nested/b.txt', text: 'B' },
		]);

		const result = await extractZipFile(archive);

		expect(result.needsPassword).toBe(false);
		expect(result.entries.map(entry => entry.path)).toEqual(['photos/a.txt', 'photos/nested/b.txt']);
		expect(await result.entries[0]?.file.text()).toBe('A');
		expect(await result.entries[1]?.file.text()).toBe('B');
	});

	test('trims a single root directory inside the zip before adding the zip root', async () => {
		const archive = await zipFile('nagaoka.zip', [
			{ path: 'nagaoka/a.txt', text: 'A' },
			{ path: 'nagaoka/nested/b.txt', text: 'B' },
		]);

		const result = await extractZipFile(archive);

		expect(result.entries.map(entry => entry.path)).toEqual(['nagaoka/a.txt', 'nagaoka/nested/b.txt']);
	});

	test('does not turn empty directories into upload entries', async () => {
		const archive = await zipFile('archive.zip', [
			{ path: 'empty/', directory: true },
			{ path: 'nested/', directory: true },
			{ path: 'nested/file.txt', text: 'nested' },
			{ path: 'file.txt', text: 'file' },
		]);

		const result = await extractZipFile(archive);

		expect(result.entries.map(entry => entry.path)).toEqual(['archive/nested/file.txt', 'archive/file.txt']);
		expect(result.warnings).toEqual(['空ディレクトリはアップロード対象外です: empty/']);
	});

	test('requires a password for encrypted zip entries', async () => {
		const archive = await zipFile('secret.zip', [
			{ path: 'secret.txt', text: 'classified' },
		], 'opensesame');

		const withoutPassword = await extractZipFile(archive);
		expect(withoutPassword.needsPassword).toBe(true);

		const withPassword = await extractZipFile(archive, { password: 'opensesame' });
		expect(withPassword.entries.map(entry => entry.path)).toEqual(['secret/secret.txt']);
		expect(await withPassword.entries[0]?.file.text()).toBe('classified');
		await expect(extractZipFile(archive, { password: 'wrong' })).rejects.toThrow('ZIP password is invalid');
	});

	test('rejects dangerous zip paths', () => {
		expect(normalizeZipEntryPath('/abs.txt')).toBeNull();
		expect(normalizeZipEntryPath('C:\\abs.txt')).toBeNull();
		expect(normalizeZipEntryPath('../escape.txt')).toBeNull();
		expect(normalizeZipEntryPath('safe/../escape.txt')).toBeNull();
		expect(normalizeZipEntryPath('safe//empty.txt')).toBeNull();
		expect(normalizeZipEntryPath('__MACOSX/._file')).toBeNull();
		expect(normalizeZipEntryPath('safe\\path.txt')).toBe('safe/path.txt');
	});
});
