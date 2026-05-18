/**
 * Web Worker: tar / tar.gz を ZIP に変換してダウンロードさせる。
 *
 * メインスレッドから TarToZipRequest を受け取り、
 * 進捗 (TarToZipProgress) と完了 (TarToZipResult) または
 * エラー (TarToZipError) を postMessage で返す。
 *
 * 処理フロー:
 *   fetch → (gzip/BGZF解凍) → tarパース → fflate Zip で ZIP 化 → Blob 返却
 */

import { isBgzf, createBgzfDecompressor } from 'bgzf';
import { Zip, ZipPassThrough, type FlateError } from 'fflate';

// ---- Message types ----

export interface TarToZipRequest {
	/** ダウンロードURL（/d/<bucket>/<path> 形式） */
	url: string;
	/** tar.gz かどうか (false なら plain tar) */
	isTargz: boolean;
	/** 認証トークン。null なら未認証 */
	token: string | null;
	/** ダウンロードファイル名（拡張子なし） */
	baseName: string;
}

export interface TarToZipProgress {
	type: 'progress';
	/** 処理済みファイル数 */
	processedFiles: number;
	/** 現在処理中のファイル名 */
	currentFile: string;
}

export interface TarToZipResult {
	type: 'done';
	blob: Blob;
	filename: string;
}

export interface TarToZipError {
	type: 'error';
	message: string;
}

export type TarToZipMessage = TarToZipProgress | TarToZipResult | TarToZipError;

// ---- tar parser ----

interface TarEntry {
	name: string;
	/** type flag: '0' = 通常ファイル, '5' = ディレクトリ, etc. */
	type: string;
	size: number;
}

/**
 * 512バイトの tar ヘッダーブロックを解析する。
 * ゼロブロック（end-of-archive）の場合は null を返す。
 */
function parseTarHeader(block: Uint8Array<ArrayBuffer>): TarEntry | null {
	// ゼロブロック検出
	const isZero = block.every(b => b === 0);
	if (isZero) return null;

	const dec = new TextDecoder();

	// name: offset 0, length 100
	const name = dec.decode(block.subarray(0, 100)).replace(/\0+$/, '');

	// typeflag: offset 156, length 1
	const type = String.fromCharCode(block[156]);

	// size: offset 124, length 12 (octal string, null-terminated)
	const sizeStr = dec.decode(block.subarray(124, 136)).replace(/\0+$/, '').trim();
	// GNU tar の base-256 エンコーディング対応: 先頭バイトが 0x80 の場合
	let size: number;
	if (block[124] === 0x80) {
		// base-256: 残りのバイトをビッグエンディアン整数として読む
		size = 0;
		for (let i = 125; i < 136; i++) {
			size = size * 256 + block[i];
		}
	} else {
		size = parseInt(sizeStr, 8) || 0;
	}

	return { name, type, size };
}

/**
 * ReadableStream<Uint8Array> から tar エントリを順番に読み出し、
 * callback に (entry, dataStream) を渡す。
 *
 * 呼び出し元は callback の返す Promise が resolve されるまで
 * 次のエントリには進まない（逐次処理）。
 */
async function parseTarStream(
	stream: ReadableStream<Uint8Array>,
	onEntry: (entry: TarEntry, data: ReadableStream<Uint8Array>) => Promise<void>,
): Promise<void> {
	const reader = stream.getReader();

	// バッファ管理: 512バイト境界単位で読む
	let buf = new Uint8Array(0) as Uint8Array<ArrayBuffer>;

	async function readBytes(n: number): Promise<Uint8Array<ArrayBuffer> | null> {
		while (buf.length < n) {
			const { done, value } = await reader.read();
			if (done) {
				if (buf.length === 0) return null;
				// ストリーム終端だがバッファに残りがある場合は返す
				break;
			}
			const merged = new Uint8Array(buf.length + value.length) as Uint8Array<ArrayBuffer>;
			merged.set(buf);
			merged.set(value, buf.length);
			buf = merged;
		}
		if (buf.length < n) return null;
		const result = buf.slice(0, n) as Uint8Array<ArrayBuffer>;
		buf = buf.slice(n) as Uint8Array<ArrayBuffer>;
		return result;
	}

	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	while (true) {
		// ヘッダーブロック (512 bytes)
		const headerBlock = await readBytes(512);
		if (!headerBlock) break;

		const entry = parseTarHeader(headerBlock);
		if (!entry) break; // end-of-archive (zero block)

		const { size, type } = entry;

		// データブロックのパディング込みサイズ（512バイト境界）
		const paddedSize = size === 0 ? 0 : Math.ceil(size / 512) * 512;

		if (type === '0' || type === '\0') {
			// 通常ファイル: データをストリームとして callback に渡す
			// callback が完全に消費するまで待機
			let remaining = size;
			let paddingRemaining = paddedSize - size;

			const dataStream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (remaining === 0) {
						controller.close();
						return;
					}
					const toRead = Math.min(remaining, 65536);
					const chunk = await readBytes(toRead);
					if (!chunk) {
						controller.close();
						return;
					}
					remaining -= chunk.length;
					controller.enqueue(chunk);
				},
			});

			await onEntry(entry, dataStream);

			// パディング部分を読み飛ばす
			if (paddingRemaining > 0) {
				await readBytes(paddingRemaining);
			}
		} else {
			// ディレクトリなど: データブロックをスキップ
			if (paddedSize > 0) {
				await readBytes(paddedSize);
			}
		}
	}

	reader.releaseLock();
}

// ---- gzip 解凍ストリーム ----

/**
 * ReadableStream に gzip または BGZF の解凍 TransformStream を接続する。
 * 先頭バイトを読んで BGZF かどうかを判定してから適切なデコンプレッサを使う。
 */
async function makeDecompressedStream(
	rawStream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
	const reader = rawStream.getReader();

	// BGZF 判定のために先頭 18 バイトを読む
	let peek = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
	while (peek.length < 18) {
		const { done, value } = await reader.read();
		if (done) break;
		const merged = new Uint8Array(peek.length + value.length) as Uint8Array<ArrayBuffer>;
		merged.set(peek);
		merged.set(value, peek.length);
		peek = merged;
	}
	reader.releaseLock();

	// 先頭バイトをストリームに戻す (prepend)
	const prepended = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(peek);
		},
		pull(controller) {
			// rawStream の残りをそのまま流す
			const r = rawStream.getReader();
			const pump = async () => {
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				while (true) {
					const { done, value } = await r.read();
					if (done) { controller.close(); break; }
					controller.enqueue(value);
				}
			};
			return pump();
		},
	});

	if (isBgzf(peek)) {
		// BGZF: カスタムデコンプレッサを使う
		return prepended.pipeThrough(createBgzfDecompressor());
	} else {
		// 通常 gzip
		// DecompressionStream の writable の型定義は WritableStream<BufferSource> だが、
		// ブラウザの実装は Uint8Array も受け付けるため、型のみ整合させる。
		const ds = new DecompressionStream('gzip');
		return prepended.pipeThrough(ds as TransformStream<Uint8Array<ArrayBufferLike>, Uint8Array>);
	}
}

// ---- メイン処理 ----

async function convert(req: TarToZipRequest): Promise<Blob> {
	const { url, isTargz, token, baseName: _baseName } = req;
	const fetchHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

	const res = await fetch(url, { headers: fetchHeaders });
	if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);

	let tarStream: ReadableStream<Uint8Array> = res.body!;
	if (isTargz) {
		tarStream = await makeDecompressedStream(tarStream);
	}

	return new Promise<Blob>((resolve, reject) => {
		const outputChunks: Uint8Array[] = [];
		let processedFiles = 0;

		const zip = new Zip((err: FlateError | null, data: Uint8Array<ArrayBuffer>, final: boolean) => {
			if (err) { reject(err); return; }
			outputChunks.push(data);
			if (final) {
				const total = outputChunks.reduce((s, c) => s + c.length, 0);
				const out = new Uint8Array(total);
				let pos = 0;
				for (const c of outputChunks) { out.set(c, pos); pos += c.length; }
				resolve(new Blob([out], { type: 'application/zip' }));
			}
		});

		parseTarStream(tarStream, async (entry, dataStream) => {
			const progress: TarToZipProgress = {
				type: 'progress',
				processedFiles,
				currentFile: entry.name,
			};
			self.postMessage(progress);

			const file = new ZipPassThrough(entry.name);
			zip.add(file);

			const reader = dataStream.getReader();
			try {
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						file.push(new Uint8Array(0), true);
						break;
					}
					file.push(value, false);
				}
			} finally {
				reader.releaseLock();
			}

			processedFiles++;
		}).then(() => {
			zip.end();
		}).catch(reject);
	});
}

// ---- Worker entry point ----

self.onmessage = async (event: MessageEvent<TarToZipRequest>) => {
	const req = event.data;
	try {
		const blob = await convert(req);
		const result: TarToZipResult = {
			type: 'done',
			blob,
			filename: req.baseName + '.zip',
		};
		self.postMessage(result);
	} catch (err) {
		const error: TarToZipError = {
			type: 'error',
			message: err instanceof Error ? err.message : String(err),
		};
		self.postMessage(error);
	}
};
