/**
 * File System Access API (`showSaveFilePicker`) を使った直接保存の補助ユーティリティ。
 *
 * ダウンロード時、対応ブラウザでは OPFS を経由せずユーザーが選んだ保存先に直接書き込むことで、
 * OPFS のストレージクォータ超過 (issue #131) を回避する。
 * 非対応・失敗時は呼び出し側で OPFS へのフォールバックを行う。
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

/** 保存先の解決結果。picker が使えればそのハンドル、使えなければ OPFS へフォールバック。 */
export type SaveTarget =
	| { readonly kind: 'picker'; readonly fileHandle: FileSystemFileHandle }
	| { readonly kind: 'opfs' };

/**
 * ダウンロードの保存先を決定する。
 *
 * - `showSaveFilePicker` 対応時はダイアログを表示し、選ばれたハンドルを返す（OPFS・クォータを回避）。
 * - ユーザーがダイアログをキャンセルした場合は {@link DownloadCancelledError} をスローする（ダウンロード中止）。
 * - 非対応またはキャンセル以外の失敗時は OPFS へフォールバックする。
 * - OPFS も利用できない場合はエラーをスローする。
 */
export async function resolveSaveTarget(filename: string, mimeType: string): Promise<SaveTarget> {
	const fileHandle = await pickSaveFileHandle(filename, mimeType);
	if (fileHandle) return { kind: 'picker', fileHandle };
	if (!('storage' in navigator) || !navigator.storage.getDirectory) {
		throw new Error('このブラウザはファイルの直接保存および OPFS に対応していないため、ダウンロードできません。');
	}
	return { kind: 'opfs' };
}
