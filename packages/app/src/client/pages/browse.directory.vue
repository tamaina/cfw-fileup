<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import * as v from 'valibot';
import type { FileVisibility } from '../../shared/file-visibility';
import { Button, Popover } from '@vuetify/v0';
import { FileIcon, Folder } from '@lucide/vue';
import NirA from '@/components/nira.vue';
import { authStore, authHeaders } from '@/store/auth';
import { apiPost } from '@/utils/api';
import { setPendingUpload } from '@/store/pending-upload';
import { mainRouter } from '@/router';
import ConfirmDialog from '@/components/confirm-dialog.vue';
import InputDialog from '@/components/input-dialog.vue';
import { MAX_DIRECTORY_NAME_LENGTH, MAX_FILE_PATH_LENGTH } from '../../shared/const';
import { UploadTree } from '@/utils/upload-tree';
import type { ArchiveDownloadWorkerMessage, ArchiveDownloadWorkerRequest, ArchiveDownloadProgress } from '@/workers/archive-download.worker';
import type { DownloadTransformWorkerMessage, DownloadTransformWorkerRequest } from '@/workers/download-transform.worker';
import { getOpfsTempFile, removeOpfsTempFile } from '@/workers/opfs-temp';
import { completeDownloadStatus, failDownloadStatus, startDownloadStatus, updateDownloadStatus } from '@/store/download-status';
import { registerDownloadedOpfsFile } from '@/store/download-cleanup';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	isTargz: boolean;
	isTar: boolean;
	entryPath?: string;
	fileId?: string;
	token?: string;
}>();

const isArchive = computed(() => props.isTargz || props.isTar);

interface DisplayEntry {
	key: string;
	name: string;
	link: string;
	isDir: boolean;
	fullPath: string;
	size?: number;
	fileId?: string;
	label: string;
	visibility?: FileVisibility;
	previewUrl?: string;
}

const downloadUrl = computed(() => {
	if (!props.fileId) return '';
	const base = `/d/${props.fileId}`;
	return props.token ? `${base}?token=${props.token}` : base;
});

const entries = ref<DisplayEntry[]>([]);
const error = ref('');
const loading = ref(true);
const isDragOver = ref(false);
const deleteError = ref('');

type RawArchiveEntry = { id: string; path: string; mimeType: string; size?: number };
const allArchiveEntries = ref<RawArchiveEntry[]>([]);
const archivePath = ref('');

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const bucketId = ref<string | null>(null);
const newDirName = ref('');
const mkdirError = ref('');
const mkdirDialog = ref(false);

const directoryNameSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1, 'フォルダ名を入力してください'),
	v.maxLength(MAX_DIRECTORY_NAME_LENGTH, `フォルダ名は${MAX_DIRECTORY_NAME_LENGTH}文字以内で入力してください`),
	v.regex(/^[^/\\]+$/, 'フォルダ名に / や \\ は使えません'),
);

const deleteDialog = ref(false);
const deleteTarget = ref<DisplayEntry | null>(null);
const archiveDeleteDialog = ref(false);

type ViewMode = 'list' | 'grid';
const VIEW_MODE_KEY = 'cfw-fileup:dir-view-mode';
const viewMode = ref<ViewMode>((localStorage.getItem(VIEW_MODE_KEY) as ViewMode | null) ?? 'list');

function setViewMode(mode: ViewMode): void {
	viewMode.value = mode;
	localStorage.setItem(VIEW_MODE_KEY, mode);
}

function isImageMime(mime: string): boolean {
	return mime.startsWith('image/');
}

// 一括選択・削除用の状態
const selectedPaths = ref<Set<string>>(new Set());
const bulkDeleteDialog = ref(false);
const excludedPaths = ref<Set<string>>(new Set());
const selectAllMode = ref(false);
const selectionPopoverOpen = ref(false);
const headerCheckbox = ref<HTMLInputElement | null>(null);
const archiveDownloadError = ref('');
const archiveDownloadProgress = ref<ArchiveDownloadProgress | null>(null);
let archiveDownloadWorker: Worker | null = null;
let downloadTransformWorker: Worker | null = null;
let archiveDownloadRequestId = 0;
const archiveDownloadRequests = new Map<string, {
	resolve: (value: { opfsName: string; filename: string; mimeType: string }) => void;
	reject: (error: Error & { opfsName?: string }) => void;
}>();
const downloadTransformRequests = new Map<string, {
	resolve: (value: { opfsName: string; filename: string; mimeType: string }) => void;
	reject: (error: Error & { opfsName?: string }) => void;
}>();

/** 選択可能なエントリ */
const selectableEntries = computed(() => entries.value);
const canSelectEntries = computed(() => !isArchive.value);
const canDeleteSelectedEntries = computed(() => !isArchive.value && authStore.user != null && bucketId.value != null);

const selectedCount = computed(() => {
	if (selectAllMode.value) return Math.max(0, selectableEntries.value.length - excludedPaths.value.size);
	return selectedPaths.value.size;
});

const isAllEntriesSelected = computed(() => {
	if (selectableEntries.value.length === 0) return false;
	return selectableEntries.value.every(e => selectedPaths.value.has(e.fullPath));
});

const selectionBadgeLabel = computed(() => {
	if (selectAllMode.value) return excludedPaths.value.size === 0 ? '全件' : `-${excludedPaths.value.size}件`;
	return `${selectedCount.value}件`;
});

const tableColspan = computed(() => {
	if (isArchive.value) return 3;
	if (authStore.user && bucketId.value) return 6;
	if (authStore.user) return 5;
	return 4;
});

const archiveProgressLabel = computed(() => {
	const progress = archiveDownloadProgress.value;
	if (!progress) return '';
	const phase = progress.phase === 'resolving' ? '対象解決中'
		: progress.phase === 'reading' ? '読み込み中'
			: progress.phase === 'writing' ? '書き込み中'
				: '完了';
	const total = progress.totalFiles > 0 ? ` / ${progress.totalFiles}` : '';
	const current = progress.currentFile ? `: ${progress.currentFile}` : '';
	return `${phase} ${progress.processedFiles}${total}${current}`;
});

/** 全選択チェックボックスの状態 */
const isAllSelected = computed(() => {
	if (selectableEntries.value.length === 0) return false;
	return (selectAllMode.value && excludedPaths.value.size === 0) || isAllEntriesSelected.value;
});

/** 一部選択状態（indeterminate） */
const isPartiallySelected = computed(() => {
	const count = selectedCount.value;
	return count > 0 && count < selectableEntries.value.length;
});

async function syncHeaderCheckbox(): Promise<void> {
	await nextTick();
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	if (headerCheckbox.value) {
		headerCheckbox.value.checked = isAllSelected.value;
		headerCheckbox.value.indeterminate = isPartiallySelected.value;
	}
}

function toggleSelectAll(): void {
	if (!canSelectEntries.value || selectableEntries.value.length === 0) return;

	if (selectAllMode.value) {
		if (excludedPaths.value.size > 0) {
			excludedPaths.value.clear();
			void syncHeaderCheckbox();
			return;
		}
		selectedPaths.value = new Set(selectableEntries.value.map(e => e.fullPath));
		excludedPaths.value.clear();
		selectAllMode.value = false;
		void syncHeaderCheckbox();
		return;
	}

	if (isAllEntriesSelected.value) {
		selectAllMode.value = true;
		selectedPaths.value.clear();
		excludedPaths.value.clear();
		void syncHeaderCheckbox();
		return;
	}

	selectedPaths.value = new Set(selectableEntries.value.map(e => e.fullPath));
	excludedPaths.value.clear();
	selectAllMode.value = false;
	void syncHeaderCheckbox();
}

function selectAllEntries(): void {
	if (!canSelectEntries.value || selectableEntries.value.length === 0) return;
	selectedPaths.value.clear();
	excludedPaths.value.clear();
	selectAllMode.value = true;
}

function clearSelection(): void {
	selectedPaths.value.clear();
	excludedPaths.value.clear();
	selectAllMode.value = false;
	selectionPopoverOpen.value = false;
}

function requestBulkDelete(): void {
	if (!canDeleteSelectedEntries.value) return;
	selectionPopoverOpen.value = false;
	bulkDeleteDialog.value = true;
}

function getArchiveDownloadWorker(): Worker {
	if (archiveDownloadWorker) return archiveDownloadWorker;
	archiveDownloadWorker = new Worker(new URL('../workers/archive-download.worker.ts', import.meta.url), { type: 'module' });
	archiveDownloadWorker.onmessage = (event: MessageEvent<ArchiveDownloadWorkerMessage>) => {
		const message = event.data;
		if (message.type === 'progress') {
			archiveDownloadProgress.value = message.progress;
			updateDownloadStatus(message.id, message.progress);
			return;
		}
		const pending = archiveDownloadRequests.get(message.id);
		if (!pending) return;
		archiveDownloadRequests.delete(message.id);
		if (message.type === 'done') {
			pending.resolve({ opfsName: message.opfsName, filename: message.filename, mimeType: message.mimeType });
		} else {
			const error = new Error(message.error) as Error & { opfsName?: string };
			error.opfsName = message.opfsName;
			pending.reject(error);
		}
	};
	return archiveDownloadWorker;
}

function runArchiveDownloadWorker(request: Omit<ArchiveDownloadWorkerRequest, 'id'>): Promise<{ opfsName: string; filename: string; mimeType: string }> {
	const id = String(++archiveDownloadRequestId);
	return new Promise((resolve, reject) => {
		archiveDownloadRequests.set(id, { resolve, reject });
		getArchiveDownloadWorker().postMessage({ ...request, id });
	});
}

function getDownloadTransformWorker(): Worker {
	if (downloadTransformWorker) return downloadTransformWorker;
	downloadTransformWorker = new Worker(new URL('../workers/download-transform.worker.ts', import.meta.url), { type: 'module' });
	downloadTransformWorker.onmessage = (event: MessageEvent<DownloadTransformWorkerMessage>) => {
		const message = event.data;
		if (message.type === 'progress') {
			archiveDownloadProgress.value = message.progress;
			updateDownloadStatus(message.id, message.progress);
			return;
		}
		const pending = downloadTransformRequests.get(message.id);
		if (!pending) return;
		downloadTransformRequests.delete(message.id);
		if (message.type === 'done') {
			pending.resolve({ opfsName: message.opfsName, filename: message.filename, mimeType: message.mimeType });
		} else if (message.type === 'error') {
			const error = new Error(message.error) as Error & { opfsName?: string };
			error.opfsName = message.opfsName;
			pending.reject(error);
		}
	};
	return downloadTransformWorker;
}

function runDownloadTransformWorker(request: Omit<DownloadTransformWorkerRequest, 'id'>): Promise<{ opfsName: string; filename: string; mimeType: string }> {
	const id = `download-${++archiveDownloadRequestId}`;
	return new Promise((resolve, reject) => {
		downloadTransformRequests.set(id, { resolve, reject });
		getDownloadTransformWorker().postMessage({ ...request, id });
	});
}

async function cleanupOpfsFile(opfsName: string | undefined): Promise<void> {
	if (!opfsName) return;
	await removeOpfsTempFile(opfsName);
}

async function downloadOpfsFile(result: { opfsName: string; filename: string; mimeType: string }): Promise<void> {
	const sourceFile = await getOpfsTempFile(result.opfsName);
	const file = new File([sourceFile], result.filename, { type: result.mimeType, lastModified: sourceFile.lastModified });
	const url = URL.createObjectURL(file);
	registerDownloadedOpfsFile(url, result.opfsName);
	const a = document.createElement('a');
	a.href = url;
	a.download = result.filename;
	document.body.append(a);
	a.click();
	a.remove();
}

function archiveBaseNameFromPath(path: string): string {
	const segments = path.split('/').filter(Boolean);
	return (segments.at(-1) ?? props.bucketName).replace(/\.(?:tar|tar\.gz)$/i, '') || 'archive';
}

function selectedArchiveTargets(): Array<
	| { type: 'file'; path: string; fileId: string; size: number }
	| { type: 'directory'; path: string }
> {
	if (selectAllMode.value) return [{ type: 'directory', path: props.filePath }];
	return Array.from(selectedPaths.value).map((path) => {
		const entry = entries.value.find(item => item.fullPath === path);
		if (!entry || entry.isDir) return { type: 'directory' as const, path };
		if (!entry.fileId) throw new Error(`fileId is missing for ${entry.name}`);
		return { type: 'file' as const, path, fileId: entry.fileId, size: entry.size ?? 0 };
	});
}

async function startDirectoryArchiveDownload(format: 'tar' | 'zip'): Promise<void> {
	selectionPopoverOpen.value = false;
	archiveDownloadError.value = '';
	archiveDownloadProgress.value = null;
	if (!navigator.storage?.getDirectory) {
		archiveDownloadError.value = 'このブラウザは OPFS に対応していないため、アーカイブを作成できません。';
		return;
	}
	const filename = `${archiveBaseNameFromPath(props.filePath)}.${format}`;
	const statusId = String(archiveDownloadRequestId + 1);
	startDownloadStatus(statusId, filename);
	try {
		const result = await runArchiveDownloadWorker({
			mode: 'directory',
			format,
			bucketName: props.bucketName,
			basePath: props.filePath,
			targets: selectedArchiveTargets(),
			excludePaths: Array.from(excludedPaths.value),
			authHeaders: authHeaders(),
			filename,
		});
		await downloadOpfsFile(result);
		completeDownloadStatus(statusId);
		archiveDownloadProgress.value = null;
	} catch (err) {
		await cleanupOpfsFile((err as Error & { opfsName?: string }).opfsName);
		downloadTransformWorker?.terminate();
		downloadTransformWorker = null;
		const message = err instanceof Error ? err.message : String(err);
		failDownloadStatus(statusId, message);
		archiveDownloadError.value = message;
	}
}

async function startArchiveToZipDownload(): Promise<void> {
	archiveDownloadError.value = '';
	archiveDownloadProgress.value = null;
	if (!props.fileId) return;
	if (!navigator.storage?.getDirectory) {
		archiveDownloadError.value = 'このブラウザは OPFS に対応していないため、ZIP を作成できません。';
		return;
	}
	const filename = `${archiveBaseNameFromPath(props.filePath)}.zip`;
	const statusId = String(archiveDownloadRequestId + 1);
	startDownloadStatus(statusId, filename);
	try {
		const result = await runArchiveDownloadWorker({
			mode: 'archive-to-zip',
			fileId: props.fileId,
			token: props.token,
			isTargz: props.isTargz,
			filename,
			authHeaders: authHeaders(),
		});
		await downloadOpfsFile(result);
		completeDownloadStatus(statusId);
		archiveDownloadProgress.value = null;
	} catch (err) {
		await cleanupOpfsFile((err as Error & { opfsName?: string }).opfsName);
		archiveDownloadWorker?.terminate();
		archiveDownloadWorker = null;
		const message = err instanceof Error ? err.message : String(err);
		failDownloadStatus(statusId, message);
		archiveDownloadError.value = message;
	}
}

async function startFullArchiveDownload(decompress: boolean): Promise<void> {
	archiveDownloadError.value = '';
	archiveDownloadProgress.value = null;
	if (!props.fileId) return;
	if (!navigator.storage?.getDirectory) {
		archiveDownloadError.value = 'このブラウザは OPFS に対応していないため、アーカイブをダウンロードできません。';
		return;
	}
	const baseName = archiveBaseNameFromPath(props.filePath);
	const filename = `${baseName}${decompress ? '.tar' : '.tar.gz'}`;
	const statusId = `download-${archiveDownloadRequestId + 1}`;
	startDownloadStatus(statusId, filename);
	try {
		const result = await runDownloadTransformWorker({
			mode: 'download',
			url: downloadUrl.value,
			filename,
			mimeType: decompress ? 'application/x-tar' : 'application/gzip',
			transform: decompress ? 'decompress-gzip' : 'recompress-bgzf',
			authHeaders: authHeaders(),
		});
		await downloadOpfsFile(result);
		completeDownloadStatus(statusId);
		archiveDownloadProgress.value = null;
	} catch (err) {
		await cleanupOpfsFile((err as Error & { opfsName?: string }).opfsName);
		archiveDownloadWorker?.terminate();
		archiveDownloadWorker = null;
		const message = err instanceof Error ? err.message : String(err);
		failDownloadStatus(statusId, message);
		archiveDownloadError.value = message;
	}
}

function toggleSelect(path: string): void {
	if (!canSelectEntries.value) return;

	if (selectAllMode.value) {
		const next = new Set(excludedPaths.value);
		if (next.has(path)) {
			next.delete(path);
		} else {
			next.add(path);
		}
		excludedPaths.value = next;
		return;
	}

	const next = new Set(selectedPaths.value);
	if (next.has(path)) {
		next.delete(path);
	} else {
		next.add(path);
	}
	selectedPaths.value = next;
}

function isEntrySelected(entry: DisplayEntry): boolean {
	return selectAllMode.value ? !excludedPaths.value.has(entry.fullPath) : selectedPaths.value.has(entry.fullPath);
}

async function loadBucketId(): Promise<void> {
	if (!authStore.user) return;
	const result = await apiPost('/api/buckets/list');
	if (!result.ok) return;
	bucketId.value = result.data.buckets.find(b => b.name === props.bucketName)?.id ?? null;
}

function openMkdirDialog(): void {
	newDirName.value = '';
	mkdirError.value = '';
	mkdirDialog.value = true;
}

async function createDirectory(name: string): Promise<void> {
	if (!bucketId.value) return;
	mkdirError.value = '';
	const path = `${props.filePath}${name}/`;
	if (path.length > MAX_FILE_PATH_LENGTH) {
		mkdirError.value = `パスは${MAX_FILE_PATH_LENGTH}文字以内で入力してください`;
		return;
	}
	const dirResult = await apiPost('/api/directories/create', { bucketId: bucketId.value!, path });
	if (!dirResult.ok) {
		mkdirError.value = dirResult.data.error;
		return;
	}
	mkdirDialog.value = false;
	newDirName.value = '';
	await load();
}

function requestDeleteEntry(entry: DisplayEntry): void {
	deleteTarget.value = entry;
	deleteDialog.value = true;
}

async function executeDeleteEntry(): Promise<void> {
	if (!deleteTarget.value) return;
	const entry = deleteTarget.value;
	deleteDialog.value = false;
	deleteTarget.value = null;
	deleteError.value = '';

	if (entry.isDir) {
		const delResult = await apiPost('/api/files/delete', { bucketId: bucketId.value!, targets: [{ type: 'directory', path: entry.fullPath }] });
		if (!delResult.ok) {
			deleteError.value = delResult.data.error;
			return;
		}
	} else {
		if (!bucketId.value) {
			deleteError.value = '削除できません（バケットIDが不明）';
			return;
		}
		const delResult = await apiPost('/api/files/delete', { bucketId: bucketId.value, path: entry.fullPath });
		if (!delResult.ok) {
			deleteError.value = delResult.data.error ?? '削除失敗';
			return;
		}
	}
	await load();
}

async function executeBulkDelete(): Promise<void> {
	bulkDeleteDialog.value = false;
	deleteError.value = '';
	if (!bucketId.value) {
		deleteError.value = '削除できません（バケットIDが不明）';
		return;
	}

	const targets = selectAllMode.value
		? [{ type: 'directory' as const, path: props.filePath, excludePaths: Array.from(excludedPaths.value) }]
		: Array.from(selectedPaths.value).map((path) => {
			const entry = entries.value.find(e => e.fullPath === path);
			return { type: entry?.isDir ? 'directory' as const : 'file' as const, path };
		});

	const result = await apiPost('/api/files/delete', { bucketId: bucketId.value, targets });
	selectedPaths.value.clear();
	excludedPaths.value.clear();
	selectAllMode.value = false;
	selectionPopoverOpen.value = false;

	if (!result.ok) {
		deleteError.value = result.data.error ?? '削除失敗';
		return;
	}

	await load();
}

function buildArchiveEntries(): void {
	const seenDirs = new Set<string>();
	const result: DisplayEntry[] = [];

	for (const e of allArchiveEntries.value) {
		if (!e.path.startsWith(archivePath.value)) continue;
		const rest = e.path.slice(archivePath.value.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx === -1) {
			result.push({
				key: e.id,
				name: rest,
				link: `/v/${props.bucketName}/${props.filePath}?file=${encodeURIComponent(e.path)}`,
				isDir: false,
				fullPath: e.path,
				size: e.size,
				fileId: e.id,
				label: e.mimeType,
			});
		} else {
			const dirName = rest.slice(0, slashIdx);
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				result.push({
					key: `dir:${archivePath.value}${dirName}`,
					name: dirName,
					link: `/v/${props.bucketName}/${props.filePath}?file=${encodeURIComponent(`${archivePath.value}${dirName}/`)}`,
					isDir: true,
					fullPath: `${archivePath.value}${dirName}/`,
					label: 'フォルダ',
				});
			}
		}
	}

	result.sort((a, b) => {
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	entries.value = result;
}

function navigateArchiveDir(path: string): void {
	mainRouter.pushByPath(`/v/${props.bucketName}/${props.filePath}?file=${encodeURIComponent(path)}`);
}

function navigateArchiveUp(): void {
	const parts = archivePath.value.replace(/\/$/, '').split('/');
	parts.pop();
	const newPath = parts.length === 0 ? '' : parts.join('/') + '/';
	if (newPath === '') {
		mainRouter.pushByPath(`/v/${props.bucketName}/${props.filePath}`);
	} else {
		mainRouter.pushByPath(`/v/${props.bucketName}/${props.filePath}?file=${encodeURIComponent(newPath)}`);
	}
}

async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	// ロード時に選択状態をリセット
	selectedPaths.value.clear();
	excludedPaths.value.clear();
	selectAllMode.value = false;
	try {
		if (isArchive.value) {
			const listUrl = props.token ? `${downloadUrl.value}&list` : `${downloadUrl.value}?list`;
			const res = await fetch(listUrl, { headers: authHeaders() });
			if (!res.ok) { error.value = `取得失敗: ${res.status}`; return; }
			const raw = await res.json() as RawArchiveEntry[];
			archivePath.value = props.entryPath ?? '';
			allArchiveEntries.value = raw;
			buildArchiveEntries();
		} else {
			const data = authStore.user
				? await (async () => {
					const result = await apiPost('/api/files/ls', { bucketName: props.bucketName, path: props.filePath });
					if (!result.ok && result.status === 403) return await fetchPublicDirectoryEntries();
					if (!result.ok) {
						error.value = result.data.error;
						return null;
					}
					return result.data;
				})()
				: await fetchPublicDirectoryEntries();
			if (data === null) return;
			entries.value = data.entries.map(e => {
				if (e.type === 'dir') {
					return {
					key: `dir:${e.name}`,
					name: e.name,
					link: `/v/${props.bucketName}/${props.filePath}${e.name}/`,
					isDir: true,
					fullPath: `${props.filePath}${e.name}/`,
					label: 'フォルダ',
					};
				}
				const mime = e.isTargz ? 'application/gzip' : e.isTar ? 'application/x-tar' : (e.mimeType ?? '');
				const previewUrl = isImageMime(mime) && e.fileId ? `/d/${e.fileId}` : undefined;
				return {
					key: `file:${e.name}`,
					name: e.name,
					link: `/v/${props.bucketName}/${e.path}`,
					isDir: false,
					fullPath: e.path ?? e.name,
					size: e.size,
					fileId: e.fileId,
					label: e.isTargz ? 'tar.gz' : e.isTar ? 'tar' : mime,
					visibility: e.visibility,
					previewUrl,
				};
			});
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

function parentPath(): string | null {
	if (!props.filePath) return null;
	if (isArchive.value) {
		// archive subdir navigation is handled by navigateArchiveUp
		if (archivePath.value !== '') return null;
		// at archive root: go to the file's parent directory
		const parts = props.filePath.split('/');
		parts.pop();
		return parts.length === 0
			? `/v/${props.bucketName}/`
			: `/v/${props.bucketName}/${parts.join('/')}/`;
	}
	const parts = props.filePath.replace(/\/$/, '').split('/');
	parts.pop();
	return parts.length === 0
		? `/v/${props.bucketName}/`
		: `/v/${props.bucketName}/${parts.join('/')}/`;
}

async function goUpload(): Promise<void> {
	setPendingUpload(await UploadTree.from([]), props.bucketName, props.filePath);
	mainRouter.pushByPath('/uploader');
}

function onDragOver(e: DragEvent): void {
	if (isArchive.value || !authStore.user) return;
	e.preventDefault();
	isDragOver.value = true;
}

function onDragLeave(): void {
	isDragOver.value = false;
}

async function onDrop(e: DragEvent): Promise<void> {
	isDragOver.value = false;
	if (isArchive.value || !authStore.user) return;
	e.preventDefault();
	const data = e.dataTransfer;
	if (!data) return;
	try {
		const tree = await UploadTree.from(data);
		if (tree.entries.length === 0) return;
		setPendingUpload(tree, props.bucketName, props.filePath);
		mainRouter.pushByPath('/uploader');
	} catch {
		const droppedFiles = Array.from(data.files ?? []);
		if (droppedFiles.length === 0) return;
		setPendingUpload(await UploadTree.from(droppedFiles), props.bucketName, props.filePath);
		mainRouter.pushByPath('/uploader');
	}
}

async function executeDeleteArchive(): Promise<void> {
	archiveDeleteDialog.value = false;
	deleteError.value = '';
	if (!bucketId.value) {
		deleteError.value = '削除できません（バケットIDが不明）';
		return;
	}
	const delResult = await apiPost('/api/files/delete', { bucketId: bucketId.value, path: props.filePath });
	if (!delResult.ok) {
		deleteError.value = delResult.data.error ?? '削除失敗';
		return;
	}
	const parts = props.filePath.split('/');
	parts.pop();
	const parent = parts.length === 0
		? `/v/${props.bucketName}/`
		: `/v/${props.bucketName}/${parts.join('/')}/`;
	mainRouter.pushByPath(parent);
}

async function fetchPublicDirectoryEntries(): Promise<{
	entries: Array<{
		type: 'dir' | 'file'; name: string; path?: string;
		fileId?: string; size?: number; mimeType?: string; isTargz?: boolean; isTar?: boolean; visibility?: FileVisibility;
	}>;
} | null> {
	const lsUrl = `/api/files/ls?bucketName=${encodeURIComponent(props.bucketName)}&path=${encodeURIComponent(props.filePath)}`;
	const res = await fetch(lsUrl);
	if (!res.ok) {
		error.value = `取得失敗: ${res.status}`;
		return null;
	}
	return await res.json() as {
		entries: Array<{
			type: 'dir' | 'file'; name: string; path?: string;
			fileId?: string; size?: number; mimeType?: string; isTargz?: boolean; isTar?: boolean; visibility?: FileVisibility;
		}>;
	};
}

onMounted(() => {
	load();
	loadBucketId();
});
onBeforeUnmount(() => {
	archiveDownloadWorker?.terminate();
	archiveDownloadWorker = null;
	downloadTransformWorker?.terminate();
	downloadTransformWorker = null;
});
watch(() => [props.bucketName, props.filePath], () => { load(); loadBucketId(); });
watch(() => props.entryPath, (newEntryPath) => {
	if (isArchive.value) {
		archivePath.value = newEntryPath ?? '';
		buildArchiveEntries();
	}
});
watch([isPartiallySelected, isAllSelected], async () => {
	await syncHeaderCheckbox();
}, { immediate: true, flush: 'post' });
</script>

<template>
  <div>

    <div class="card file-actions flex gap-2 items-center mb-3 flex-wrap">
      <!-- アーカイブ操作 -->
      <template v-if="isArchive" class="flex gap-2 items-center mb-3 flex-wrap">
        <button v-if="isTargz" type="button" class="btn btn-primary" :disabled="archiveDownloadProgress != null" @click="startFullArchiveDownload(false)">ダウンロード (.tar.gz)</button>
        <a v-else :href="downloadUrl" download class="btn btn-primary">ダウンロード</a>
        <button v-if="isTargz" type="button" class="btn btn-secondary" :disabled="archiveDownloadProgress != null" @click="startFullArchiveDownload(true)">展開してダウンロード (.tar)</button>
        <button type="button" class="btn btn-secondary" :disabled="archiveDownloadProgress != null" @click="startArchiveToZipDownload">
          zipとしてダウンロード
        </button>
        <Button.Root v-if="authStore.user" class="btn btn-ghost-danger" @click="archiveDeleteDialog = true">
          <Button.Content>削除</Button.Content>
        </Button.Root>
        <span v-if="deleteError" :class="[$style.inlineError, 'alert', 'alert-error']">{{ deleteError }}</span>
      </template>

      <!-- 通常ディレクトリ操作 -->
      <template v-if="!isArchive && authStore.user">
        <Button.Root class="btn btn-primary" @click="goUpload">
          <Button.Content>アップロード</Button.Content>
        </Button.Root>
        <button type="button" class="btn btn-secondary" :disabled="!bucketId" @click="openMkdirDialog">
          フォルダ作成
        </button>
      </template>

      <!-- 一括選択 -->
      <template v-if="canSelectEntries">
        <button
          v-if="canSelectEntries && selectableEntries.length > 0 && selectedCount === 0"
          type="button"
          :class="['btn', $style.selectAllButton]"
          @click="selectAllEntries"
        >
          全て選択
        </button>

        <Popover.Root v-if="canSelectEntries && selectedCount > 0" v-model="selectionPopoverOpen">
          <Popover.Activator :class="['btn', 'btn-secondary', $style.selectionButton]" aria-haspopup="true">
            <span>選択中</span>
            <span :class="['badge', selectAllMode ? 'badge-success' : 'badge-info', $style.selectionBadge]">
              {{ selectionBadgeLabel }}
            </span>
          </Popover.Activator>
          <Popover.Content class="action-menu">
            <div class="action-menu-inner">
              <Button.Root v-if="canDeleteSelectedEntries" class="btn btn-ghost-danger w-full" :class="$style.menuItem" @click="requestBulkDelete">
                <Button.Content>まとめて削除</Button.Content>
              </Button.Root>
              <Button.Root class="btn btn-ghost w-full" :class="$style.menuItem" :disabled="archiveDownloadProgress != null" @click="startDirectoryArchiveDownload('tar')">
                <Button.Content>tarとしてダウンロード</Button.Content>
              </Button.Root>
              <Button.Root class="btn btn-ghost w-full" :class="$style.menuItem" :disabled="archiveDownloadProgress != null" @click="startDirectoryArchiveDownload('zip')">
                <Button.Content>zipとしてダウンロード</Button.Content>
              </Button.Root>
              <Button.Root class="btn btn-ghost w-full" :class="$style.menuItem" @click="clearSelection">
                <Button.Content>選択を解除</Button.Content>
              </Button.Root>
            </div>
          </Popover.Content>
        </Popover.Root>
      </template>
    </div>

    <div :class="$style.viewToggle" aria-label="表示形式">
      <button
        :class="[$style.viewToggleButton, viewMode === 'list' && $style.viewToggleButtonActive]"
        type="button"
        title="リストビュー"
        @click="setViewMode('list')"
      >
        リスト
      </button>
      <button
        :class="[$style.viewToggleButton, viewMode === 'grid' && $style.viewToggleButtonActive]"
        type="button"
        title="グリッドビュー"
        @click="setViewMode('grid')"
      >
        グリッド
      </button>
    </div>

    <div v-if="loading" class="page-loading">
      <span class="spinner" />読み込み中...
    </div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <template v-else>
      <div v-if="archiveProgressLabel" class="alert alert-info mb-3">{{ archiveProgressLabel }}</div>
      <div v-if="archiveDownloadError" class="alert alert-error mb-3">{{ archiveDownloadError }}</div>
      <div v-if="deleteError" class="alert alert-error mb-3">{{ deleteError }}</div>

      <div
        class="drop-zone"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <div v-if="isDragOver" class="drop-zone-overlay">ここにドロップしてアップロード</div>

        <div v-if="viewMode === 'list'" :class="[$style.tableCard, 'card']">
          <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <!-- チェックボックス列 -->
                <th v-if="!isArchive" :class="$style.checkboxCell">
                  <input
                    ref="headerCheckbox"
                    type="checkbox"
                    :class="[$style.checkbox, selectAllMode && $style.checkboxSelectAll]"
                    :checked="isAllSelected"
                    :disabled="!canSelectEntries || selectableEntries.length === 0"
                    @click.prevent="toggleSelectAll"
                  >
                </th>
                <th>名前</th>
                <th class="col-right">サイズ</th>
                <th>種類</th>
                <th v-if="!isArchive && authStore.user">公開</th>
                <th v-if="!isArchive && authStore.user && bucketId" class="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="isArchive && archivePath !== ''">
                <td :colspan="3">
                  <button :class="$style.upButton" @click="navigateArchiveUp">..</button>
                </td>
              </tr>
              <tr v-else-if="parentPath()">
                <td :colspan="tableColspan">
                  <NirA :to="parentPath()!" :class="$style.upLink">..</NirA>
                </td>
              </tr>
              <tr v-for="entry in entries" :key="entry.key">
                <!-- チェックボックスセル -->
                <td v-if="!isArchive" :class="$style.checkboxCell">
                  <input
                    type="checkbox"
                    :class="$style.checkbox"
                    :checked="isEntrySelected(entry)"
                    :disabled="!canSelectEntries"
                    @change="toggleSelect(entry.fullPath)"
                  >
                </td>
                <td :class="$style.nameCell">
                  <button v-if="isArchive && entry.isDir" :class="$style.archiveDirButton" @click="navigateArchiveDir(entry.fullPath)">
                    <Folder :class="$style.folderIcon" :size="16" :stroke-width="2" aria-hidden="true" />{{ entry.name }}
                  </button>
                  <NirA v-else-if="isArchive && !entry.isDir" :to="entry.link" :class="$style.entryLink">{{ entry.name }}</NirA>
                  <NirA v-else :to="entry.link" :class="$style.entryLink">
                    <Folder v-if="entry.isDir" :class="$style.folderIcon" :size="16" :stroke-width="2" aria-hidden="true" />{{ entry.name }}
                  </NirA>
                </td>
                <td :class="[$style.sizeCell, 'col-right', 'col-muted']">
                  {{ entry.size != null ? formatSize(entry.size) : '' }}
                </td>
                <td :class="$style.labelCell">
                  <span v-if="entry.label" class="badge badge-muted">{{ entry.label }}</span>
                </td>
                <td v-if="!isArchive && authStore.user" :class="$style.publicCell">
                  <span v-if="!entry.isDir && entry.visibility != null" :class="entry.visibility === 'public' ? 'badge badge-success' : entry.visibility === 'passphrase' ? 'badge badge-warning' : 'badge badge-muted'">
                    {{ entry.visibility === 'public' ? '公開' : entry.visibility === 'passphrase' ? '合言葉' : '非公開' }}
                  </span>
                </td>
                <td v-if="!isArchive && authStore.user && bucketId" class="col-actions" :class="$style.actionsCell">
                  <Button.Root class="btn btn-ghost-danger" @click="requestDeleteEntry(entry)">
                    <Button.Content>削除</Button.Content>
                  </Button.Root>
                </td>
              </tr>
              <tr v-if="entries.length === 0">
                <td :colspan="tableColspan">
                  <div class="empty-state">
                    <p>エントリがありません。</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
        <template v-else>
          <div v-if="isArchive && archivePath !== ''" class="mb-2">
            <button :class="$style.upButton" type="button" @click="navigateArchiveUp">..</button>
          </div>
          <div v-else-if="parentPath()" class="mb-2">
            <NirA :to="parentPath()!" :class="$style.upLink">..</NirA>
          </div>

          <div v-if="entries.length === 0" class="empty-state card">
            <p>エントリがありません。</p>
          </div>
          <div v-else :class="$style.gridView">
            <div
              v-for="entry in entries"
              :key="entry.key"
              :class="[$style.gridCard, isEntrySelected(entry) && $style.gridCardSelected]"
            >
              <div v-if="!isArchive" :class="$style.gridCheckboxCell">
                <input
                  type="checkbox"
                  :class="$style.checkbox"
                  :checked="isEntrySelected(entry)"
                  :disabled="!canSelectEntries"
                  @change="toggleSelect(entry.fullPath)"
                >
              </div>
              <component
                :is="isArchive && entry.isDir ? 'button' : NirA"
                :class="[$style.gridCardPreview, isArchive && entry.isDir ? $style.gridCardPreviewButton : '']"
                :to="!(isArchive && entry.isDir) ? entry.link : undefined"
                type="button"
                @click="isArchive && entry.isDir ? navigateArchiveDir(entry.fullPath) : undefined"
              >
                <img
                  v-if="entry.previewUrl"
                  :src="entry.previewUrl"
                  :alt="entry.name"
                  :class="$style.gridCardImage"
                  loading="lazy"
                  decoding="async"
                >
                <div v-else :class="$style.gridCardIcon">
                  <Folder v-if="entry.isDir" :size="42" :stroke-width="1.8" aria-hidden="true" />
                  <FileIcon v-else :size="34" :stroke-width="1.8" aria-hidden="true" />
                </div>
              </component>
              <div :class="$style.gridCardInfo">
                <div :class="$style.gridCardName" :title="entry.name">{{ entry.name }}</div>
                <div :class="$style.gridCardMeta">
                  <span v-if="entry.size != null" :class="$style.gridCardSize">{{ formatSize(entry.size) }}</span>
                  <span v-if="entry.label" class="badge badge-muted">{{ entry.label }}</span>
                  <span v-if="!entry.isDir && entry.visibility != null && !isArchive" :class="entry.visibility === 'public' ? 'badge badge-success' : entry.visibility === 'passphrase' ? 'badge badge-warning' : 'badge badge-muted'">
                    {{ entry.visibility === 'public' ? '公開' : entry.visibility === 'passphrase' ? '合言葉' : '非公開' }}
                  </span>
                </div>
                <div v-if="!isArchive && authStore.user && bucketId" :class="$style.gridCardActions">
                  <Button.Root :class="['btn', 'btn-ghost-danger', $style.gridCardDeleteButton]" @click="requestDeleteEntry(entry)">
                    <Button.Content>削除</Button.Content>
                  </Button.Root>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>

    <!-- 削除確認ダイアログ（エントリ） -->
    <ConfirmDialog
      v-model:open="deleteDialog"
      :title="deleteTarget?.isDir ? 'フォルダを削除' : 'ファイルを削除'"
      :message="deleteTarget ? (deleteTarget.isDir ? `フォルダ「${deleteTarget.name}」とその中身を削除しますか？` : `ファイル「${deleteTarget.name}」を削除しますか？`) : ''"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeDeleteEntry"
      @cancel="deleteDialog = false"
    />

    <!-- 一括削除確認ダイアログ -->
    <ConfirmDialog
      v-if="canDeleteSelectedEntries"
      v-model:open="bulkDeleteDialog"
      title="複数エントリを削除"
      :message="selectAllMode ? `このフォルダの中身を削除しますか？${excludedPaths.size > 0 ? `（${excludedPaths.size} 件を除外）` : ''}` : `選択した ${selectedCount} 件のエントリを削除しますか？`"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeBulkDelete"
      @cancel="bulkDeleteDialog = false"
    />

    <InputDialog
      v-if="authStore.user"
      v-model:open="mkdirDialog"
      v-model="newDirName"
      title="フォルダ作成"
      label="フォルダ名"
      confirm-label="作成"
      :schema="directoryNameSchema"
      :external-error="mkdirError"
      :mono="true"
      @submit="createDirectory"
      @cancel="mkdirError = ''"
    />

    <!-- 削除確認ダイアログ（アーカイブ） -->
    <ConfirmDialog
      v-model:open="archiveDeleteDialog"
      title="アーカイブを削除"
      :message="`「${filePath}」を削除しますか？`"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeDeleteArchive"
      @cancel="archiveDeleteDialog = false"
    />
  </div>
</template>

<style module lang="scss">
.inlineError {
  padding: 4px 10px;
  font-size: 0.8rem;
}

.selectAllButton {
  background: transparent;
  color: #15803d;
  border-color: transparent;
}

.selectAllButton:hover {
  color: #fff;
  background: #16a34a;
}

:global([data-theme="dark"]) .selectAllButton {
  color: #4ade80;
}

:global([data-theme="dark"]) .selectAllButton:hover {
  color: #052e16;
  background: #86efac;
}

.selectionButton {
  gap: 6px;
}

.selectionBadge {
  margin-left: 2px;
}

.menuItem {
  justify-content: flex-start;
}

.tableCard {
  padding: 0;
  overflow: hidden;
}

.viewToggle {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.viewToggleButton {
  min-width: 72px;
  padding: 6px 12px;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-text);
  cursor: pointer;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #d5dbe3);
}

.viewToggleButton:first-child {
  border-radius: 6px 0 0 6px;
}

.viewToggleButton + .viewToggleButton {
  margin-left: -1px;
  border-radius: 0 6px 6px 0;
}

.viewToggleButton:hover {
  background: var(--color-bg);
}

.viewToggleButtonActive,
.viewToggleButtonActive:hover {
  z-index: 1;
  color: #fff;
  background: var(--color-primary);
  border-color: var(--color-primary);
}

.checkboxCell {
  width: 1em;
  padding-right: 6px !important;
  padding-left: 6px !important;
  text-align: center !important;
}

.checkbox {
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: var(--color-primary);
}

.checkboxSelectAll {
  accent-color: #16a34a;
}

.upButton {
  display: inline-flex;
  align-items: center;
  min-width: 42px;
  padding: 4px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--color-primary);
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-primary);
  border-radius: 6px;
  cursor: pointer;
  text-decoration: none;
}

.upLink {
  display: inline-flex;
  align-items: center;
  min-width: 42px;
  padding: 4px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--color-primary);
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-primary);
  border-radius: 6px;
  text-decoration: none;
}

.upButton:hover,
.upLink:hover {
  color: #fff;
  background: var(--color-primary);
}

.nameCell {
  width: 50%;
  min-width: 10em;
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archiveDirButton {
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  font-weight: 500;
  font-size: inherit;
  color: inherit;
}

.folderIcon {
  margin-right: 4px;
  color: var(--color-text-muted);
  vertical-align: -3px;
}

.entryLink {
  display: inline-flex;
  align-items: center;
  font-weight: 500;
}

.sizeCell {
  white-space: nowrap;
}

.labelCell {
  white-space: nowrap;
}

.publicCell {
  white-space: nowrap;
}

.actionsCell {
  white-space: nowrap;
}

.gridView {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.gridCard {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e0e0e0);
  border-radius: 8px;
}

.gridCardSelected {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 1px var(--color-primary);
}

.gridCheckboxCell {
  position: absolute;
  z-index: 1;
  top: 6px;
  left: 6px;
  display: flex;
  padding: 3px;
  background: var(--color-surface, #fff);
  border-radius: 4px;
  box-shadow: 0 1px 4px rgb(0 0 0 / 14%);
}

.gridCardPreview {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: auto;
  aspect-ratio: 1 / 1;
  color: var(--color-text-muted);
  text-decoration: none;
  background: var(--color-bg);
}

.gridCardPreviewButton {
  border: 0;
  cursor: pointer;
  padding: 0;
}

.gridCardImage {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gridCardIcon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--color-text-muted);
}

.gridCardInfo {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  padding: 8px;
}

.gridCardName {
  overflow: hidden;
  font-size: 0.85rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gridCardMeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 20px;
}

.gridCardSize {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.gridCardActions {
  margin-top: 2px;
}

.gridCardDeleteButton {
  width: 100%;
  justify-content: center;
  padding-block: 4px;
  font-size: 0.75rem;
}
</style>
