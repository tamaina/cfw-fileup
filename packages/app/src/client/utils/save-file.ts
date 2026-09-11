import { createStreamDownload } from './stream-download';
/**
 * SW ストリーム保存・File System Access API・OPFS の保存先選択。
 *
 * ダウンロード時、対応ブラウザでは OPFS を経由せずユーザーが選んだ保存先に直接書き込むことで、
 * OPFS のストレージクォータ超過 (issue #131) を回避する。
 * 順次出力では SW の attachment Response を優先し、利用できなければ直接保存・OPFS の順に試す。
 */

type ShowSaveFilePickerWindow = Window & {
	showSaveFilePicker?: (options?: {
		suggestedName?: string;
		types?: Array<{ description?: string; accept: Record<string, string[]> }>;
		excludeAcceptAllOption?: boolean;
	}) => Promise<FileSystemFileHandle>;
};

/** `showSaveFilePicker` が利用可能かどうか */
export function supportsSaveFilePicker(): boolean {
	return typeof window !== 'undefined'
		&& typeof (window as ShowSaveFilePickerWindow).showSaveFilePicker === 'function';
}

/** ユーザーが保存ダイアログをキャンセルしたことを示すエラー。ダウンロード自体を中止する。 */
export class DownloadCancelledError extends Error {
	constructor() {
		super('Download cancelled by user');
		this.name = 'DownloadCancelledError';
	}
}

/** OPFS のストレージクォータが足りないことを示すエラー。 */
export class StorageQuotaExceededError extends Error {
	readonly requiredBytes: number;
	readonly availableBytes: number;

	constructor(requiredBytes: number, availableBytes: number) {
		super('Storage quota exceeded');
		this.name = 'StorageQuotaExceededError';
		this.requiredBytes = requiredBytes;
		this.availableBytes = availableBytes;
	}
}

/** 1 GiB。このサイズ以上の OPFS ダウンロード前に永続化を要求する。 */
const PERSIST_THRESHOLD_BYTES = 1024 * 1024 * 1024;

/**
 * ストレージの永続化を要求する。
 * 永続化されると、ブラウザがOPFSなどのストレージを多く確保するようになり、自動削除しにくくなる。
 */
export async function requestPersistentStorage(): Promise<boolean> {
	if (!('storage' in navigator) || typeof navigator.storage.persist !== 'function') return false;
	try {
		return await navigator.storage.persist();
	} catch {
		return false;
	}
}

/**
 * OPFS の空き容量がダウンロードに必要なサイズを満たすか確認する。
 * 満たさない場合は {@link StorageQuotaExceededError} をスローする。
 */
export async function ensureOpfsQuota(requiredBytes: number): Promise<void> {
	if (!('storage' in navigator) || typeof navigator.storage.estimate !== 'function') return;
	const estimate = await navigator.storage.estimate();
	const quota = estimate.quota ?? 0;
	const usage = estimate.usage ?? 0;
	const available = quota - usage;
	if (available < requiredBytes) {
		throw new StorageQuotaExceededError(requiredBytes, available);
	}
}

function extensionFromFilename(filename: string): string {
	const match = filename.match(/(\.[^./]+)$/);
	return match?.[1] ?? '';
}

/**
 * 保存先ファイルのハンドルを取得する。
 *
 * - `showSaveFilePicker` 対応時はダイアログを表示し、ユーザーが選んだハンドルを返す。
 * - ユーザーがダイアログをキャンセルした場合は {@link DownloadCancelledError} をスローする（ダウンロード中止）。
 * - `showSaveFilePicker` が非対応、またはキャンセル以外の理由で失敗した場合は `null` を返す
 *   （呼び出し側は OPFS へのフォールバックを行う）。
 */
export async function pickSaveFileHandle(filename: string, mimeType: string): Promise<FileSystemFileHandle | null> {
	const win = window as ShowSaveFilePickerWindow;
	if (typeof win.showSaveFilePicker !== 'function') return null;
	try {
		const ext = extensionFromFilename(filename);
		const types = mimeType && ext
			? [{ accept: { [mimeType]: [ext] } }]
			: undefined;
		return await win.showSaveFilePicker({ suggestedName: filename, types });
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') {
			throw new DownloadCancelledError();
		}
		console.warn('showSaveFilePicker failed, falling back to OPFS', err);
		return null;
	}
}

/** Worker からのダウンロード完了結果。`savedDirectly` が true なら OPFS を経由せず保存済み。 */
export type WorkerDownloadResult = {
	readonly opfsName?: string;
	readonly savedDirectly: boolean;
	readonly filename: string;
	readonly mimeType: string;
};

/** 保存先の解決結果。順次出力は stream、seek が必要な出力は picker / OPFS。 */
export type SaveTarget =
	| { readonly kind: 'picker'; readonly fileHandle: FileSystemFileHandle }
	| { readonly kind: 'opfs' }
	| { readonly kind: 'stream'; readonly writable: WritableStream<Uint8Array> };

/**
 * ダウンロードの保存先を決定する。
 *
 * - 順次出力では既存 SW へのストリーム転送を優先する。
 * - seek が必要な MP4 などは sequential=false を指定する。
 *
 * - `showSaveFilePicker` 対応時はダイアログを表示し、選ばれたハンドルを返す（OPFS・クォータを回避）。
 * - ユーザーがダイアログをキャンセルした場合は {@link DownloadCancelledError} をスローする（ダウンロード中止）。
 * - 非対応またはキャンセル以外の失敗時は OPFS へフォールバックする。
 * - OPFS フォールバック時、`requiredBytes` が指定されていれば空き容量を確認し、
 *   不足していれば {@link StorageQuotaExceededError} をスローする。
 * - OPFS も利用できない場合はエラーをスローする。
 */
export async function resolveSaveTarget(filename: string, mimeType: string, requiredBytes?: number, sequential = true): Promise<SaveTarget> {
	if (sequential) {
		const writable = await createStreamDownload(filename);
		if (writable) return { kind: 'stream', writable };
	}
	const fileHandle = await pickSaveFileHandle(filename, mimeType);
	if (fileHandle) return { kind: 'picker', fileHandle };
	if (!('storage' in navigator) || !navigator.storage.getDirectory) {
		throw new Error('このブラウザはファイルの直接保存および OPFS に対応していないため、ダウンロードできません。');
	}
	if (!requiredBytes || requiredBytes >= PERSIST_THRESHOLD_BYTES) {
		await requestPersistentStorage();
	}
	if (requiredBytes != null) {
		await ensureOpfsQuota(requiredBytes);
	}
	return { kind: 'opfs' };
}
