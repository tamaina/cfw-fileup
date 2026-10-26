/**
 * 端末に保存済みの暗号化ファイル（「暗号化されたままダウンロード」で保存したもの）を、
 * このブラウザに保存された復号キーで復元するためのユーティリティ。
 *
 * ファイル全体を arrayBuffer() で読み込まず、Blob.stream() → AES-CTR 復号 → 保存先 WritableStream
 * とストリームで流すことで、iPhone などメモリの少ない環境でも大きなファイルを扱えるようにする。
 */

import { AES_CTR_IV_LENGTH, createAesCtrDecryptTransform, importAesCtrKey, multibaseToKey } from '../../shared/encryption';

/** 選択されたファイルが、閲覧中の暗号化ファイルと一致しないことを示すエラー。 */
export class EncryptedFileMismatchError extends Error {
	readonly actualBytes: number;
	readonly expectedBytes: number;

	constructor(actualBytes: number, expectedBytes: number) {
		super('選択したファイルは、このページの暗号化ファイルと一致しません（サイズが異なります）。「暗号化されたままダウンロード」で保存したファイルを選択してください。');
		this.name = 'EncryptedFileMismatchError';
		this.actualBytes = actualBytes;
		this.expectedBytes = expectedBytes;
	}
}

/**
 * 選択されたファイルが復元対象として妥当かを検査する。
 *
 * AES-CTR は改ざん検知を持たないため、別のファイルを選ぶと何も言わずに壊れたデータが出力される。
 * サーバー上の暗号化ファイルのサイズ（IV を含む）が分かっていれば、それと一致するかで取り違えを防ぐ。
 */
export function assertRestorableEncryptedFile(actualBytes: number, expectedEncryptedBytes: number | null | undefined): void {
	if (actualBytes < AES_CTR_IV_LENGTH) {
		throw new EncryptedFileMismatchError(actualBytes, expectedEncryptedBytes ?? AES_CTR_IV_LENGTH);
	}
	if (expectedEncryptedBytes != null && actualBytes !== expectedEncryptedBytes) {
		throw new EncryptedFileMismatchError(actualBytes, expectedEncryptedBytes);
	}
}

/** 復号後のサイズ（IV を除いたバイト数）。 */
export function decryptedSizeOf(encryptedBytes: number): number {
	return Math.max(0, encryptedBytes - AES_CTR_IV_LENGTH);
}

export type RestoreProgress = {
	readonly completedBytes: number;
	readonly totalBytes: number;
};

/**
 * 暗号化ファイル（[IV || AES-256-CTR 暗号文]）を復号しながら writable に書き込む。
 * 完了すると writable は close される。失敗時は abort される。
 */
export async function restoreEncryptedBlobToWritable(
	source: Blob,
	keyMultibase: string,
	writable: WritableStream<Uint8Array>,
	onProgress?: (progress: RestoreProgress) => void,
): Promise<void> {
	const rawKey = multibaseToKey(keyMultibase);
	if (!rawKey) {
		await writable.abort(new Error('Invalid encryption key')).catch(() => {});
		throw new Error('復号キーの形式が正しくありません。');
	}
	const cryptoKey = await importAesCtrKey(rawKey, ['decrypt']);
	const totalBytes = source.size;
	let completedBytes = 0;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			completedBytes += chunk.byteLength;
			onProgress?.({ completedBytes, totalBytes });
			controller.enqueue(chunk);
		},
	});
	// pipeTo は失敗時に writable を abort し、成功時に close する
	await (source.stream() as ReadableStream<Uint8Array>)
		.pipeThrough(counter)
		.pipeThrough(createAesCtrDecryptTransform(cryptoKey))
		.pipeTo(writable);
}
