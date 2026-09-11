import { finishStreamDownload } from '@/utils/stream-download';
/**
 * ダウンロード用 Worker のライフサイクルをコンポーネント外で管理するモジュール。
 *
 * 従来は各ページコンポーネントが Worker を生成・terminate していたため、
 * ルート遷移（タブ移動）でコンポーネントが unmount されると Worker が強制終了し、
 * ダウンロードが中断される問題があった。
 *
 * このモジュールは Worker をシングルトンとして保持し、コンポーネントの unmount に
 * 影響されずダウンロードが完了するまで生き続ける。
 */
import type { DownloadTransformWorkerMessage, DownloadTransformWorkerRequestInput } from '@/workers/download-transform.worker';
import type { ArchiveDownloadWorkerMessage, ArchiveDownloadWorkerRequest } from '@/workers/archive-download.worker';
import type { DistributiveOmit } from '../../shared/type-hack';
import type { WorkerDownloadResult } from '@/utils/save-file';
import { updateDownloadStatus } from '@/store/download-status';

type PendingRequest = {
	worker: 'transform' | 'archive';
	resolve: (value: WorkerDownloadResult) => void;
	reject: (error: Error & { opfsName?: string }) => void;
};

type ProgressCallback = (progress: unknown) => void;

let downloadTransformWorker: Worker | null = null;
let archiveDownloadWorker: Worker | null = null;
let requestId = 0;

const pendingRequests = new Map<string, PendingRequest>();
const progressCallbacks = new Map<string, ProgressCallback>();

// --- download-transform worker ---

function getDownloadTransformWorker(): Worker {
	if (downloadTransformWorker) return downloadTransformWorker;
	downloadTransformWorker = new Worker(new URL('../workers/download-transform.worker.ts', import.meta.url), { type: 'module' });
	downloadTransformWorker.onmessage = (event: MessageEvent<DownloadTransformWorkerMessage>) => {
		const message = event.data;
		if (message.type === 'progress') {
			updateDownloadStatus(message.id, message.progress);
			progressCallbacks.get(message.id)?.(message.progress);
			return;
		}
		const pending = pendingRequests.get(message.id);
		if (!pending) return;
		pendingRequests.delete(message.id);
		progressCallbacks.delete(message.id);
		if (message.type === 'done') {
			pending.resolve({ opfsName: message.opfsName, savedDirectly: message.savedDirectly, filename: message.filename, mimeType: message.mimeType });
		} else {
			const error = new Error(message.error) as Error & { opfsName?: string };
			error.opfsName = message.opfsName;
			pending.reject(error);
		}
	};
	downloadTransformWorker.onerror = () => terminateDownloadTransformWorker();
	downloadTransformWorker.onmessageerror = () => terminateDownloadTransformWorker();
	return downloadTransformWorker;
}

// --- archive-download worker ---

function getArchiveDownloadWorker(): Worker {
	if (archiveDownloadWorker) return archiveDownloadWorker;
	archiveDownloadWorker = new Worker(new URL('../workers/archive-download.worker.ts', import.meta.url), { type: 'module' });
	archiveDownloadWorker.onmessage = (event: MessageEvent<ArchiveDownloadWorkerMessage>) => {
		const message = event.data;
		if (message.type === 'progress') {
			updateDownloadStatus(message.id, message.progress);
			progressCallbacks.get(message.id)?.(message.progress);
			return;
		}
		const pending = pendingRequests.get(message.id);
		if (!pending) return;
		pendingRequests.delete(message.id);
		progressCallbacks.delete(message.id);
		if (message.type === 'done') {
			pending.resolve({ opfsName: message.opfsName, savedDirectly: message.savedDirectly, filename: message.filename, mimeType: message.mimeType });
		} else {
			const error = new Error(message.error) as Error & { opfsName?: string };
			error.opfsName = message.opfsName;
			pending.reject(error);
		}
	};
	archiveDownloadWorker.onerror = () => terminateArchiveDownloadWorker();
	archiveDownloadWorker.onmessageerror = () => terminateArchiveDownloadWorker();
	return archiveDownloadWorker;
}

// --- public API ---

/**
 * download-transform Worker でダウンロードを実行する。
 * 返される Promise は Worker が完了するまで解決されない（コンポーネント unmount に影響されない）。
 */
export function runDownloadTransform(request: DownloadTransformWorkerRequestInput): { id: string; promise: Promise<WorkerDownloadResult> } {
	const id = String(++requestId);
	const promise = new Promise<WorkerDownloadResult>((resolve, reject) => {
		pendingRequests.set(id, { resolve, reject, worker: 'transform' });
		try {
			getDownloadTransformWorker().postMessage({ ...request, id }, request.writable ? [request.writable] : []);
		} catch (error) {
			pendingRequests.delete(id);
			reject(error);
		}
	});
	return { id, promise: promise.then(result => {
		finishStreamDownload(request.writable);
		return result;
	}, error => {
		finishStreamDownload(request.writable, true);
		throw error;
	}) };
}

/**
 * archive-download Worker でアーカイブダウンロードを実行する。
 */
export function runArchiveDownload(request: DistributiveOmit<ArchiveDownloadWorkerRequest, 'id'>): { id: string; promise: Promise<WorkerDownloadResult> } {
	const id = String(++requestId);
	const promise = new Promise<WorkerDownloadResult>((resolve, reject) => {
		pendingRequests.set(id, { resolve, reject, worker: 'archive' });
		try {
			getArchiveDownloadWorker().postMessage({ ...request, id }, request.writable ? [request.writable] : []);
		} catch (error) {
			pendingRequests.delete(id);
			reject(error);
		}
	});
	return { id, promise: promise.then(result => {
		finishStreamDownload(request.writable);
		return result;
	}, error => {
		finishStreamDownload(request.writable, true);
		throw error;
	}) };
}

/**
 * 指定リクエスト ID の進捗コールバックを登録する。
 * コンポーネントがマウント中に呼び、unmount 時に {@link removeProgressCallback} で解除する。
 */
export function setProgressCallback(id: string, callback: ProgressCallback): void {
	progressCallbacks.set(id, callback);
}

/** 進捗コールバックを解除する（コンポーネント unmount 時）。Worker 自体は停止しない。 */
export function removeProgressCallback(id: string): void {
	progressCallbacks.delete(id);
}

/**
 * エラー時に Worker を再起動する（古い Worker を terminate して次回生成し直す）。
 * Worker が壊れた状態のまま再利用しないための安全策。
 */
function rejectWorkerRequests(worker: PendingRequest['worker']): void {
	for (const [id, pending] of pendingRequests) {
		if (pending.worker !== worker) continue;
		pendingRequests.delete(id);
		progressCallbacks.delete(id);
		pending.reject(new Error('ダウンロード処理が中断されました。再度お試しください。'));
	}
}

export function terminateDownloadTransformWorker(): void {
	rejectWorkerRequests('transform');
	downloadTransformWorker?.terminate();
	downloadTransformWorker = null;
}

export function terminateArchiveDownloadWorker(): void {
	rejectWorkerRequests('archive');
	archiveDownloadWorker?.terminate();
	archiveDownloadWorker = null;
}
