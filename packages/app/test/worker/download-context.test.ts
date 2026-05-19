import { describe, test, expect } from 'vitest';
import { DownloadContext } from '../../src/worker/utils/download-context';
import type { files } from '../../src/worker/scheme/index';

type FileRecord = typeof files.$inferSelect;

/** テスト用のファイルレコードを生成するヘルパー */
function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
	return {
		id: 'testfileid001',
		bucketId: 'bucket001',
		userId: 'user001',
		path: 'test/file.tar.gz',
		r2Key: 'bucket001/test/file.tar.gz',
		size: 1024,
		mimeType: 'application/gzip',
		isPublic: true,
		passphrase: null,
		uploadExpiresAt: Date.now() + 3600000,
		isClosed: true,
		isTargz: false,
		isTar: false,
		uploadId: null,
		partSize: 33554432,
		...overrides,
	};
}

describe('DownloadContext — acceptsGzip', () => {
	test('Accept-Encoding に gzip が含まれる場合は true', () => {
		const ctx = new DownloadContext(makeFile(), 'gzip, deflate, br');
		expect(ctx.acceptsGzip).toBe(true);
	});

	test('Accept-Encoding が空文字列の場合は false', () => {
		const ctx = new DownloadContext(makeFile(), '');
		expect(ctx.acceptsGzip).toBe(false);
	});

	test('Accept-Encoding に gzip が含まれない場合は false', () => {
		const ctx = new DownloadContext(makeFile(), 'deflate, br');
		expect(ctx.acceptsGzip).toBe(false);
	});
});

describe('DownloadContext — isTarFileDownload / isTargzFileDownload', () => {
	test('isTar=true かつ fileQuery あり → isTarFileDownload=true', () => {
		const ctx = new DownloadContext(makeFile({ isTar: true }), 'gzip', 'inner/file.txt');
		expect(ctx.isTarFileDownload).toBe(true);
		expect(ctx.isTargzFileDownload).toBe(false);
	});

	test('isTargz=true かつ fileQuery あり → isTargzFileDownload=true', () => {
		const ctx = new DownloadContext(makeFile({ isTargz: true }), 'gzip', 'inner/file.txt');
		expect(ctx.isTargzFileDownload).toBe(true);
		expect(ctx.isTarFileDownload).toBe(false);
	});

	test('isTar=true かつ fileQuery なし → isTarFileDownload=false', () => {
		const ctx = new DownloadContext(makeFile({ isTar: true }), 'gzip', undefined);
		expect(ctx.isTarFileDownload).toBe(false);
	});

	test('isTargz=true かつ fileQuery が空文字 → isTargzFileDownload=false', () => {
		const ctx = new DownloadContext(makeFile({ isTargz: true }), 'gzip', '');
		expect(ctx.isTargzFileDownload).toBe(false);
	});

	test('通常ファイル → どちらも false', () => {
		const ctx = new DownloadContext(makeFile(), 'gzip', 'inner/file.txt');
		expect(ctx.isTarFileDownload).toBe(false);
		expect(ctx.isTargzFileDownload).toBe(false);
	});
});

describe('DownloadContext — getETag (通常ファイル)', () => {
	test('gzip 対応クライアント → "fileId"', () => {
		const ctx = new DownloadContext(makeFile(), 'gzip');
		expect(ctx.getETag()).toBe('"testfileid001"');
	});

	test('gzip 非対応クライアント → "fileId-gz"', () => {
		const ctx = new DownloadContext(makeFile(), '');
		expect(ctx.getETag()).toBe('"testfileid001-gz"');
	});
});

describe('DownloadContext — getETag (tar/tar.gz 内ファイル)', () => {
	test('gzip 対応 + subPath → "fileId-encodedPath"', () => {
		const ctx = new DownloadContext(makeFile({ isTargz: true }), 'gzip', 'dir/file.txt');
		expect(ctx.getETag('dir/file.txt')).toBe('"testfileid001-dir%2Ffile.txt"');
	});

	test('gzip 非対応 + subPath → "fileId-encodedPath-gz"', () => {
		const ctx = new DownloadContext(makeFile({ isTargz: true }), '', 'dir/file.txt');
		expect(ctx.getETag('dir/file.txt')).toBe('"testfileid001-dir%2Ffile.txt-gz"');
	});

	test('subPath にパス区切りが含まれる場合、セグメントごとにエンコード', () => {
		const ctx = new DownloadContext(makeFile({ isTar: true }), 'gzip', 'a/b/c.txt');
		// 'a' → 'a', 'b' → 'b', 'c.txt' → 'c.txt' (スラッシュは残す)
		expect(ctx.getETag('a/b/c.txt')).toBe('"testfileid001-a%2Fb%2Fc.txt"');
	});

	test('subPath に特殊文字が含まれる場合はエンコード', () => {
		const ctx = new DownloadContext(makeFile({ isTargz: true }), 'gzip', 'dir/my file (1).txt');
		expect(ctx.getETag('dir/my file (1).txt')).toBe('"testfileid001-dir%2Fmy%20file%20(1).txt"');
	});
});

describe('DownloadContext — getCacheKey', () => {
	test('ETag と同じ識別子をクォートなしで返す', () => {
		const ctx = new DownloadContext(makeFile(), 'gzip');
		const etag = ctx.getETag();
		const cacheKey = ctx.getCacheKey();
		// ETagはクォートありなので、除去した値がキャッシュキーと一致する
		expect(cacheKey).toBe(etag.slice(1, -1));
	});

	test('gzip 対応 → クォートなし fileId', () => {
		const ctx = new DownloadContext(makeFile(), 'gzip');
		expect(ctx.getCacheKey()).toBe('testfileid001');
	});

	test('gzip 非対応 → クォートなし fileId-gz', () => {
		const ctx = new DownloadContext(makeFile(), '');
		expect(ctx.getCacheKey()).toBe('testfileid001-gz');
	});

	test('subPath あり・gzip 対応 → fileId-encodedPath', () => {
		const ctx = new DownloadContext(makeFile({ isTargz: true }), 'gzip', 'inner/file.txt');
		expect(ctx.getCacheKey('inner/file.txt')).toBe('testfileid001-inner%2Ffile.txt');
	});

	test('subPath あり・gzip 非対応 → fileId-encodedPath-gz', () => {
		const ctx = new DownloadContext(makeFile({ isTargz: true }), '', 'inner/file.txt');
		expect(ctx.getCacheKey('inner/file.txt')).toBe('testfileid001-inner%2Ffile.txt-gz');
	});
});
