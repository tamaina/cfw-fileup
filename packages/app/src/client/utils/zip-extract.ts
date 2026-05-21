import { BlobReader, BlobWriter, ZipReader, type Entry } from '@zip.js/zip.js';
import type { FileEntry } from 'bgzf';

export interface ZipExtractOptions {
	readonly password?: string;
	readonly onProgress?: (progress: ZipExtractProgress) => void;
}

export interface ZipExtractProgress {
	readonly fileName: string;
	readonly fileIndex: number;
	readonly totalFiles: number;
}

export interface ZipExtractResult {
	readonly entries: FileEntry[];
	readonly warnings: string[];
	readonly needsPassword: boolean;
}

export class ZipInvalidPasswordError extends Error {
	constructor() {
		super('ZIP password is invalid');
		this.name = 'ZipInvalidPasswordError';
	}
}

export async function extractZipFile(file: File, options: ZipExtractOptions = {}): Promise<ZipExtractResult> {
	const reader = new ZipReader(new BlobReader(file));
	try {
		const entries = await reader.getEntries({
			decodeText: decodeZipText,
		});
		const needsPassword = entries.some(entry => entry.encrypted);
		if (needsPassword && !options.password) {
			return { entries: [], warnings: [], needsPassword: true };
		}

		const rootName = getZipUploadRootName(file.name);
		const extracted: FileEntry[] = [];
		const warnings: string[] = [];
		const uploadFilePaths = new Set(getUploadFilePaths(entries, warnings));
		const trimRootName = getSingleRootDirectory([...uploadFilePaths]);
		let fileIndex = 0;

		for (const entry of entries) {
			if (entry.directory) continue;
			if (isSkippableZipPath(entry.filename)) continue;
			const normalizedPath = normalizeZipEntryPath(entry.filename);
			if (!normalizedPath) continue;
			const uploadPath = trimZipRootPath(normalizedPath, trimRootName);

			fileIndex += 1;
			options.onProgress?.({ fileName: entry.filename, fileIndex, totalFiles: uploadFilePaths.size });
			try {
				const blob = await entry.getData(new BlobWriter(getMimeTypeFromName(entry.filename) || 'application/octet-stream'), {
					password: options.password,
				});
				const entryFile = new File([blob], getFileNameFromPath(uploadPath), {
					type: blob.type,
					lastModified: entry.lastModDate?.getTime() || file.lastModified,
				});
				extracted.push({ path: `${rootName}/${uploadPath}`, file: entryFile });
			} catch (err) {
				if (isInvalidPasswordError(err)) throw new ZipInvalidPasswordError();
				throw err;
			}
		}
		for (const entry of entries) {
			if (!entry.directory || isSkippableZipPath(entry.filename)) continue;
			const normalizedPath = normalizeZipEntryPath(entry.filename);
			if (!normalizedPath) continue;
			const dirPrefix = `${normalizedPath}/`;
			if (![...uploadFilePaths].some(path => path.startsWith(dirPrefix))) {
				warnings.push(`空ディレクトリはアップロード対象外です: ${entry.filename}`);
			}
		}

		return { entries: extracted, warnings, needsPassword };
	} finally {
		await reader.close();
	}
}

function decodeZipText(value: Uint8Array, encoding: string): string | undefined {
	if (encoding.toLowerCase() === 'utf-8') return undefined;
	const utf8 = tryDecodeText(value, 'utf-8', true);
	if (utf8 !== null) return utf8;
	return tryDecodeText(value, 'shift-jis', false) ?? undefined;
}

function tryDecodeText(value: Uint8Array, encoding: string, fatal: boolean): string | null {
	try {
		return new TextDecoder(encoding, { fatal }).decode(value);
	} catch {
		return null;
	}
}

function getUploadFilePaths(entries: readonly Entry[], warnings: string[]): string[] {
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.directory || isSkippableZipPath(entry.filename)) continue;
		const normalizedPath = normalizeZipEntryPath(entry.filename);
		if (!normalizedPath) {
			warnings.push(`ZIP内の危険なパスをスキップしました: ${entry.filename}`);
			continue;
		}
		paths.push(normalizedPath);
	}
	return paths;
}

function getSingleRootDirectory(paths: readonly string[]): string | null {
	if (paths.length === 0) return null;
	const firstRoot = paths[0]?.split('/')[0] ?? '';
	if (!firstRoot) return null;
	if (!paths.every(path => path.startsWith(`${firstRoot}/`))) return null;
	return firstRoot;
}

function trimZipRootPath(path: string, rootName: string | null): string {
	if (!rootName || !path.startsWith(`${rootName}/`)) return path;
	return path.slice(rootName.length + 1);
}

export function getZipUploadRootName(fileName: string): string {
	const base = fileName.replace(/\.zip$/i, '').trim() || 'archive';
	const safe = base.replace(/[\\/]/g, '_').replace(/^\.+$/, 'archive');
	return safe || 'archive';
}

export function normalizeZipEntryPath(path: string): string | null {
	if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) return null;
	const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
	if (!normalized) return null;
	const segments = normalized.split('/');
	if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
	if (segments[0] === '__MACOSX') return null;
	return segments.join('/');
}

function isSkippableZipPath(path: string): boolean {
	return normalizeZipEntryPath(path) === null && path.replace(/\\/g, '/').split('/')[0] === '__MACOSX';
}

function getFileNameFromPath(path: string): string {
	return path.split('/').at(-1) || path;
}

function getMimeTypeFromName(name: string): string {
	if (/\.txt$/i.test(name)) return 'text/plain';
	if (/\.json$/i.test(name)) return 'application/json';
	if (/\.html?$/i.test(name)) return 'text/html';
	if (/\.css$/i.test(name)) return 'text/css';
	if (/\.js$/i.test(name)) return 'text/javascript';
	if (/\.svg$/i.test(name)) return 'image/svg+xml';
	if (/\.png$/i.test(name)) return 'image/png';
	if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
	if (/\.gif$/i.test(name)) return 'image/gif';
	if (/\.webp$/i.test(name)) return 'image/webp';
	if (/\.pdf$/i.test(name)) return 'application/pdf';
	return '';
}

function isInvalidPasswordError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === 'InvalidPasswordError'
		|| /password/i.test(err.message)
		|| /invalid/i.test(err.message) && /signature|encrypted|decrypt/i.test(err.message);
}
