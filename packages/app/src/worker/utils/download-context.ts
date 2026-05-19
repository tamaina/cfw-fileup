import type { files } from '../scheme/index';

type FileRecord = typeof files.$inferSelect;

/**
 * ダウンロードリクエストごとに作成するコンテキストクラス。
 * ファイルデータやリクエストの情報を入力として、ETagおよびエッジキャッシュキーで
 * 使う一意の文字列を生成する。ダウンロードで使うフラグも一元管理する。
 */
export class DownloadContext {
	private readonly file: FileRecord;

	/** クライアントが gzip エンコーディングを受け入れるか */
	readonly acceptsGzip: boolean;

	/** ?file= クエリでtar.gz内の個別ファイルをダウンロードするか */
	readonly isTargzFileDownload: boolean;

	/** ?file= クエリでtar内の個別ファイルをダウンロードするか */
	readonly isTarFileDownload: boolean;

	/**
	 * @param file DBから取得したファイルレコード
	 * @param acceptEncoding リクエストの Accept-Encoding ヘッダー値
	 * @param fileQuery ?file= クエリパラメータ（tar/tar.gz内ファイル指定）
	 */
	constructor(file: FileRecord, acceptEncoding: string, fileQuery?: string) {
		this.file = file;
		this.acceptsGzip = acceptEncoding.includes('gzip');

		const hasFileQuery = typeof fileQuery === 'string' && fileQuery.length > 0;
		this.isTargzFileDownload = hasFileQuery && file.isTargz;
		this.isTarFileDownload = hasFileQuery && file.isTar && !file.isTargz;
	}

	/**
	 * ダウンロードレスポンスに付与するETagを生成する。
	 *
	 * - gzip非対応クライアント向け（acceptsGzip=false）: 末尾に "-gz" を付加してバリアント識別
	 * - subPath指定時（tar/tar.gz内ファイル）: fileId の後に subPath を付加
	 *
	 * RFC 7232 に準拠した `"..."` クォート形式で返す。
	 *
	 * @param subPath tar/tar.gz内ファイルのパス（省略時は通常ファイルとして扱う）
	 */
	getETag(subPath?: string): string {
		return `"${this.buildUniqueKey(subPath)}"`;
	}

	/**
	 * エッジキャッシュキーに使う一意の文字列を生成する。
	 *
	 * ETagと同じ識別子を使い、プロキシキャッシュの分岐を適切に行う。
	 * ETagと異なりクォートなしの文字列で返す。
	 *
	 * @param subPath tar/tar.gz内ファイルのパス（省略時は通常ファイルとして扱う）
	 */
	getCacheKey(subPath?: string): string {
		return this.buildUniqueKey(subPath);
	}

	/**
	 * ETag・キャッシュキーの共通識別子を構築する。
	 *
	 * 形式:
	 * - 通常ファイル (gzip対応):      `<fileId>`
	 * - 通常ファイル (gzip非対応):    `<fileId>-gz`
	 * - tar/tar.gz内 (gzip対応):     `<fileId>-<encodedSubPath>`
	 * - tar/tar.gz内 (gzip非対応):   `<fileId>-<encodedSubPath>-gz`
	 *
	 * subPath内の特殊文字はパーセントエンコードして安全な文字列にする。
	 */
	private buildUniqueKey(subPath?: string): string {
		const parts: string[] = [this.file.id];

		if (subPath !== undefined && subPath.length > 0) {
			// パス内のすべての文字をエンコード（スラッシュも含む）して
			// キャッシュキーやETag内で区切り文字として誤認されないようにする
			const encodedPath = subPath
				.split('/')
				.map((segment) => encodeURIComponent(segment))
				.join('%2F');
			parts.push(encodedPath);
		}

		// gzip非対応クライアント向けはサーバー側でgz変換するため、バリアントを区別する
		if (!this.acceptsGzip) {
			parts.push('gz');
		}

		return parts.join('-');
	}
}
