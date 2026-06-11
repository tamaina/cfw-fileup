<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import * as v from 'valibot';
import type { FileVisibility } from '../../shared/file-visibility';
import { Button, Popover } from '@vuetify/v0';
import { Archive, CheckCheck, Download, EllipsisVertical, Eye, EyeOff, FileArchive, FileIcon, FileVideo, Folder, FolderPlus, LayoutGrid, List, PackageOpen, ShieldCheck, ShieldOff, TextCursorInput, Trash2, Upload, X } from '@lucide/vue';
import NirA from '@/components/NirA.vue';
import { authStore, authHeaders } from '@/store/auth';
import { apiPost } from '@/utils/api';
import { setPendingUpload } from '@/store/pending-upload';
import { mainRouter } from '@/router';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import InfiniteLoadTrigger from '@/components/InfiniteLoadTrigger.vue';
import InfiniteTableRow from '@/components/InfiniteTableRow.vue';
import AdSlot from '@/components/AdSlot.vue';
import InputDialog from '@/components/InputDialog.vue';
import MoveEntryDialog from '@/components/MoveEntryDialog.vue';
import { MAX_DIRECTORY_NAME_LENGTH, MAX_FILE_PATH_LENGTH } from '../../shared/const';
import { pathSegmentNameValidation } from '../../shared/name-validation';
import { UploadTree } from '@/utils/upload-tree';
import type { ArchiveDownloadWorkerMessage, ArchiveDownloadWorkerRequest, ArchiveDownloadProgress } from '@/workers/archive-download.worker';
import type { DownloadTransformWorkerMessage, DownloadTransformWorkerRequestInput } from '@/workers/download-transform.worker';
import { getOpfsTempFile, removeOpfsTempFile } from '@/workers/opfs-temp';
import { completeDownloadStatus, failDownloadStatus, startDownloadStatus, updateDownloadStatus } from '@/store/download-status';
import { registerDownloadedOpfsFile } from '@/store/download-cleanup';
import { formatBytes } from '@/utils/byte-size';
import { archiveEntryDownloadUrl } from '@/utils/archive-entry-url';
import type { DistributiveOmit } from '../../shared/type-hack';
import { HLS_TAR_MIME } from '../../shared/hls';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	isTargz: boolean;
	isTar: boolean;
	entryPath?: string;
	fileId?: string;
	token?: string;
	ownerCanDisableFileAds?: boolean;
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
	isListed?: boolean;
	isModerationForcedPrivate?: boolean;
	downloadCount?: number;
	isDownloadCountEnabled?: boolean;
	isDownloadCountVisible?: boolean;
	previewUrl?: string;
	isHlsTar?: boolean;
}

const downloadUrl = computed(() => {
	if (!props.fileId) return '';
	const base = `/d/${props.fileId}`;
	return props.token ? `${base}?token=${props.token}` : base;
});

function archiveEntryBrowseUrl(path: string): string {
	return `/v/${props.bucketName}/${props.filePath}/${encodeURIComponent(':entries')}/${encodeURIComponent(path)}`;
}

const entries = ref<DisplayEntry[]>([]);
const error = ref('');
const loading = ref(true);
const loadingMore = ref(false);
const directoryNextCursor = ref<string | null>(null);
const directoryHasMore = ref(false);
const isDragOver = ref(false);
const deleteError = ref('');

type RawArchiveEntry = { id: string; path: string; mimeType: string; size?: number };
type DirectoryEntry = {
	type: 'dir' | 'file';
	name: string;
	path?: string;
	fileId?: string;
	size?: number;
	mimeType?: string;
	isTargz?: boolean;
	isTar?: boolean;
	visibility?: FileVisibility;
	isListed?: boolean;
	isModerationForcedPrivate?: boolean;
	downloadCount?: number;
	isDownloadCountEnabled?: boolean;
	isDownloadCountVisible?: boolean;
};
type DirectoryPage = {
	type: 'directory';
	items: DirectoryEntry[];
	nextCursor: string | null;
	hasMore: boolean;
	ownerCanDisableFileAds: boolean;
};
const allArchiveEntries = ref<RawArchiveEntry[]>([]);
const archivePath = ref('');
const ownerCanDisableFileAds = ref(false);
const effectiveOwnerCanDisableFileAds = computed(() => isArchive.value ? props.ownerCanDisableFileAds === true : ownerCanDisableFileAds.value);

const formatSize = formatBytes;

const bucketId = ref<string | null>(null);
const newDirName = ref('');
const mkdirError = ref('');
const mkdirDialog = ref(false);

const directoryNameSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1, 'フォルダ名を入力してください'),
	v.maxLength(MAX_DIRECTORY_NAME_LENGTH, `フォルダ名は${MAX_DIRECTORY_NAME_LENGTH}文字以内で入力してください`),
	pathSegmentNameValidation,
);

const deleteDialog = ref(false);
const deleteTarget = ref<DisplayEntry | null>(null);
const archiveDeleteDialog = ref(false);
const moderationDialog = ref(false);
const moderationTarget = ref<DisplayEntry | null>(null);
const moderationValue = ref(false);
const moveDialog = ref(false);
const moveTarget = ref<DisplayEntry | null>(null);

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

function isHlsTarMime(mime: string | undefined): boolean {
	return mime?.toLowerCase() === HLS_TAR_MIME;
}

// 一括選択・削除用の状態
//
// 青選択: selectedPaths に入っている、いま読み込み済みページ上の明示選択。
// 緑選択: selectAllMode=true の、ページングの未読み込み分も含む「このディレクトリ全件」選択。
// 緑選択中の excludedPaths は、全件選択から外したパスだけを持つ。
const selectedPaths = ref<Set<string>>(new Set());
const bulkDeleteDialog = ref(false);
const bulkModerationDialog = ref(false);
const bulkModerationValue = ref(false);
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
const canUpdateSelectedListing = computed(() => !isArchive.value && authStore.user != null && bucketId.value != null);
const selectedFileEntries = computed(() => {
	const selected = selectAllMode.value
		? selectableEntries.value.filter(entry => !excludedPaths.value.has(entry.fullPath))
		: Array.from(selectedPaths.value)
			.map(path => entries.value.find(entry => entry.fullPath === path))
			.filter((entry): entry is DisplayEntry => entry != null);
	return selected.filter(entry => !entry.isDir && entry.fileId != null);
});
const canUpdateSelectedModeration = computed(() => !isArchive.value && ((authStore.user?.isAdmin ?? false) || (authStore.user?.isModerator ?? false)) && (selectAllMode.value || selectedFileEntries.value.length > 0));

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
	if (authStore.user && bucketId.value) return 7;
	if (authStore.user) return 6;
	return 5;
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

function requestBulkModerationForcedPrivate(value: boolean): void {
	if (!canUpdateSelectedModeration.value) return;
	selectionPopoverOpen.value = false;
	bulkModerationValue.value = value;
	bulkModerationDialog.value = true;
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

function runArchiveDownloadWorker(request: DistributiveOmit<ArchiveDownloadWorkerRequest, 'id'>): Promise<{ opfsName: string; filename: string; mimeType: string }> {
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

function runDownloadTransformWorker(request: DownloadTransformWorkerRequestInput): Promise<{ opfsName: string; filename: string; mimeType: string }> {
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

async function startEntryArchiveDownload(entry: DisplayEntry): Promise<void> {
	if (!entry.isDir) return;
	archiveDownloadError.value = '';
	archiveDownloadProgress.value = null;
	if (!navigator.storage?.getDirectory) {
		archiveDownloadError.value = 'このブラウザは OPFS に対応していないため、アーカイブを作成できません。';
		return;
	}
	const filename = `${entry.name}.zip`;
	const statusId = String(archiveDownloadRequestId + 1);
	startDownloadStatus(statusId, filename);
	try {
		const result = await runArchiveDownloadWorker({
			mode: 'directory',
			format: 'zip',
			bucketName: props.bucketName,
			basePath: props.filePath,
			targets: [{ type: 'directory', path: entry.fullPath }],
			excludePaths: [],
			authHeaders: authHeaders(),
			filename,
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

function isExcludedFromSelectAll(path: string): boolean {
	for (const excludedPath of excludedPaths.value) {
		if (path === excludedPath) return true;
		if (excludedPath.endsWith('/') && path.startsWith(excludedPath)) return true;
	}
	return false;
}

function selectAllDirectoryTarget(): { type: 'directory'; path: string; excludePaths?: string[] } {
	const excludes = Array.from(excludedPaths.value);
	return excludes.length === 0
		? { type: 'directory', path: props.filePath }
		: { type: 'directory', path: props.filePath, excludePaths: excludes };
}

function selectedVisibleTargets(): Array<{ type: 'file' | 'directory'; path: string }> {
	return Array.from(selectedPaths.value).map((path) => {
		const entry = entries.value.find(e => e.fullPath === path);
		return { type: entry?.isDir ? 'directory' as const : 'file' as const, path };
	});
}

function stopGridActionEvent(event: Event): void {
	event.preventDefault();
	event.stopPropagation();
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
		mkdirError.value = dirResult.data.message;
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

function requestMoveEntry(entry: DisplayEntry, event?: Event): void {
	if (event) stopGridActionEvent(event);
	moveTarget.value = entry;
	moveDialog.value = true;
}

async function handleEntryMoved(): Promise<void> {
	moveTarget.value = null;
	await load();
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
			deleteError.value = delResult.data.message;
			return;
		}
	} else {
		if (!bucketId.value) {
			deleteError.value = '削除できません（バケットIDが不明）';
			return;
		}
		const delResult = await apiPost('/api/files/delete', { bucketId: bucketId.value, path: entry.fullPath });
		if (!delResult.ok) {
			deleteError.value = delResult.data.message ?? '削除失敗';
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
		? [selectAllDirectoryTarget()]
		: selectedVisibleTargets();

	const result = await apiPost('/api/files/delete', { bucketId: bucketId.value, targets });
	selectedPaths.value.clear();
	excludedPaths.value.clear();
	selectAllMode.value = false;
	selectionPopoverOpen.value = false;

	if (!result.ok) {
		deleteError.value = result.data.message ?? '削除失敗';
		return;
	}

	await load();
}

async function executeBulkUpdateListing(isListed: boolean): Promise<void> {
	deleteError.value = '';
	if (!bucketId.value) {
		deleteError.value = '更新できません（バケットIDが不明）';
		return;
	}

	const targetEntries = selectAllMode.value
		? selectableEntries.value.filter(entry => !isExcludedFromSelectAll(entry.fullPath))
		: Array.from(selectedPaths.value)
			.map(path => entries.value.find(entry => entry.fullPath === path))
			.filter((entry): entry is DisplayEntry => entry != null);
	const targets = selectAllMode.value
		? [selectAllDirectoryTarget()]
		: targetEntries.map(entry => ({ type: entry.isDir ? 'directory' as const : 'file' as const, path: entry.fullPath }));

	const result = await apiPost('/api/files/update-listing', { bucketId: bucketId.value, targets, isListed });
	if (!result.ok) {
		deleteError.value = result.data.message ?? '更新失敗';
		return;
	}

	const targetPaths = new Set(targetEntries.map(entry => entry.fullPath));
	entries.value = entries.value.map(entry => targetPaths.has(entry.fullPath) ? { ...entry, isListed } : entry);
	selectedPaths.value.clear();
	excludedPaths.value.clear();
	selectAllMode.value = false;
	selectionPopoverOpen.value = false;
}

async function executeEntryUpdateListing(entry: DisplayEntry, isListed: boolean, event?: Event): Promise<void> {
	if (event) stopGridActionEvent(event);
	deleteError.value = '';
	if (!bucketId.value) {
		deleteError.value = '更新できません（バケットIDが不明）';
		return;
	}
	const result = await apiPost('/api/files/update-listing', {
		bucketId: bucketId.value,
		isListed,
		targets: [{ type: entry.isDir ? 'directory' as const : 'file' as const, path: entry.fullPath }],
	});
	if (!result.ok) {
		deleteError.value = result.data.message ?? '更新失敗';
		return;
	}
	entries.value = entries.value.map(item => item.fullPath === entry.fullPath ? { ...item, isListed } : item);
}

async function executeEntryUpdateModerationForcedPrivate(entry: DisplayEntry, isModerationForcedPrivate: boolean, event?: Event): Promise<void> {
	if (event) stopGridActionEvent(event);
	moderationTarget.value = entry;
	moderationValue.value = isModerationForcedPrivate;
	moderationDialog.value = true;
}

async function confirmEntryUpdateModerationForcedPrivate(): Promise<void> {
	const entry = moderationTarget.value;
	const isModerationForcedPrivate = moderationValue.value;
	moderationDialog.value = false;
	deleteError.value = '';
	if (!entry || entry.isDir || !entry.fileId) {
		deleteError.value = 'ファイルを選択してください。';
		return;
	}
	const result = await apiPost('/api/admin/update-file-moderation', {
		fileId: entry.fileId,
		isModerationForcedPrivate,
	});
	if (!result.ok) {
		deleteError.value = result.data.message ?? '更新失敗';
		return;
	}
	entries.value = entries.value.map(item => item.fullPath === entry.fullPath ? { ...item, isModerationForcedPrivate } : item);
	moderationTarget.value = null;
}

async function executeBulkUpdateModerationForcedPrivate(): Promise<void> {
	bulkModerationDialog.value = false;
	deleteError.value = '';
	const targets = selectAllMode.value
		? (await fetchAllDirectoryEntriesForSelection())
			.filter(entry => !entry.isDir && entry.fileId != null && !isExcludedFromSelectAll(entry.fullPath))
		: selectedFileEntries.value;
	if (targets.length === 0) {
		deleteError.value = 'ファイルを選択してください。';
		return;
	}

	const failed: string[] = [];
	for (const entry of targets) {
		if (!entry.fileId) continue;
		const result = await apiPost('/api/admin/update-file-moderation', {
			fileId: entry.fileId,
			isModerationForcedPrivate: bulkModerationValue.value,
		});
		if (!result.ok) {
			failed.push(entry.fullPath);
		}
	}

	if (failed.length > 0) {
		deleteError.value = `${failed.length} 件の更新に失敗しました。`;
		return;
	}

	const targetPaths = new Set(targets.map(entry => entry.fullPath));
	entries.value = entries.value.map(entry => targetPaths.has(entry.fullPath) ? { ...entry, isModerationForcedPrivate: bulkModerationValue.value } : entry);
	selectedPaths.value.clear();
	excludedPaths.value.clear();
	selectAllMode.value = false;
	selectionPopoverOpen.value = false;
}

function buildArchiveEntries(): void {
	const seenDirs = new Set<string>();
	const result: DisplayEntry[] = [];

	for (const e of allArchiveEntries.value) {
		if (!e.path.startsWith(archivePath.value)) continue;
		const rest = e.path.slice(archivePath.value.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx === -1) {
			const previewUrl = props.isTar && props.fileId && isImageMime(e.mimeType) ? archiveEntryDownloadUrl(props.fileId, e.path, props.token) : undefined;
			result.push({
				key: e.id,
				name: rest,
				link: archiveEntryBrowseUrl(e.path),
				isDir: false,
				fullPath: e.path,
				size: e.size,
				fileId: e.id,
				label: e.mimeType,
				previewUrl,
			});
		} else {
			const dirName = rest.slice(0, slashIdx);
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				result.push({
					key: `dir:${archivePath.value}${dirName}`,
					name: dirName,
					link: archiveEntryBrowseUrl(`${archivePath.value}${dirName}/`),
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
	mainRouter.pushByPath(archiveEntryBrowseUrl(path));
}

function navigateArchiveUp(): void {
	const parts = archivePath.value.replace(/\/$/, '').split('/');
	parts.pop();
	const newPath = parts.length === 0 ? '' : parts.join('/') + '/';
	if (newPath === '') {
		mainRouter.pushByPath(`/v/${props.bucketName}/${props.filePath}`);
	} else {
		mainRouter.pushByPath(archiveEntryBrowseUrl(newPath));
	}
}

async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	directoryNextCursor.value = null;
	directoryHasMore.value = false;
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
			const data = await fetchDirectoryPage(null);
			if (data === null) return;
			entries.value = data.items.map(toDisplayEntry);
			directoryNextCursor.value = data.nextCursor;
			directoryHasMore.value = data.hasMore;
			ownerCanDisableFileAds.value = data.ownerCanDisableFileAds;
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function loadMoreDirectory(): Promise<void> {
	if (!directoryHasMore.value || loadingMore.value) return;
	loadingMore.value = true;
	error.value = '';
	try {
		const data = await fetchDirectoryPage(directoryNextCursor.value);
		if (data === null) return;
		entries.value = [...entries.value, ...data.items.map(toDisplayEntry)];
		directoryNextCursor.value = data.nextCursor;
		directoryHasMore.value = data.hasMore;
		ownerCanDisableFileAds.value = data.ownerCanDisableFileAds;
	} catch (e) {
		error.value = String(e);
	} finally {
		loadingMore.value = false;
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
		deleteError.value = delResult.data.message ?? '削除失敗';
		return;
	}
	const parts = props.filePath.split('/');
	parts.pop();
	const parent = parts.length === 0
		? `/v/${props.bucketName}/`
		: `/v/${props.bucketName}/${parts.join('/')}/`;
	mainRouter.pushByPath(parent);
}

async function fetchDirectoryPage(cursor: string | null): Promise<DirectoryPage | null> {
	return await fetchDirectoryPageWithLimit(cursor, 50);
}

async function fetchDirectoryPageWithLimit(cursor: string | null, limit: number): Promise<DirectoryPage | null> {
	if (authStore.user) {
		const result = await apiPost('/api/files/ls', { bucketName: props.bucketName, path: props.filePath, limit, cursor });
		if (result.ok) return result.data;
		if (result.status !== 403) {
			error.value = result.data.message;
			return null;
		}
	}
	return await fetchPublicDirectoryEntries(cursor, limit);
}

async function fetchPublicDirectoryEntries(cursor: string | null, limit = 50): Promise<DirectoryPage | null> {
	const params = new URLSearchParams({ bucketName: props.bucketName, path: props.filePath });
	params.set('limit', String(limit));
	if (cursor) params.set('cursor', cursor);
	const lsUrl = `/api/files/ls?${params.toString()}`;
	const res = await fetch(lsUrl);
	if (!res.ok) {
		error.value = `取得失敗: ${res.status}`;
		return null;
	}
	return await res.json() as DirectoryPage;
}

async function fetchAllDirectoryEntriesForSelection(): Promise<DisplayEntry[]> {
	const result: DisplayEntry[] = [];
	let cursor: string | null = null;
	do {
		const page = await fetchDirectoryPageWithLimit(cursor, 100);
		if (page === null) return [];
		result.push(...page.items.map(toDisplayEntry));
		cursor = page.nextCursor;
	} while (cursor !== null);
	return result;
}

function toDisplayEntry(e: DirectoryEntry): DisplayEntry {
	if (e.type === 'dir') {
		return {
			key: `dir:${e.name}`,
			name: e.name,
			link: `/v/${props.bucketName}/${props.filePath}${e.name}/`,
			isDir: true,
			fullPath: `${props.filePath}${e.name}/`,
			label: 'フォルダ',
			isListed: e.isListed,
		};
	}
	const mime = e.isTargz ? 'application/gzip' : e.isTar ? 'application/x-tar' : (e.mimeType ?? '');
	const previewUrl = isImageMime(mime) && e.visibility === 'public' && e.isModerationForcedPrivate !== true && e.fileId ? `/d/${e.fileId}` : undefined;
	return {
		key: `file:${e.name}`,
		name: e.name,
		link: `/v/${props.bucketName}/${e.path}`,
		isDir: false,
		fullPath: e.path ?? e.name,
		size: e.size,
		fileId: e.fileId,
		label: isHlsTarMime(e.mimeType) ? 'HLS tar' : e.isTargz ? 'tar.gz' : e.isTar ? 'tar' : mime,
		visibility: e.visibility,
		isListed: e.isListed,
		isModerationForcedPrivate: e.isModerationForcedPrivate,
		downloadCount: e.downloadCount,
		isDownloadCountEnabled: e.isDownloadCountEnabled,
		isDownloadCountVisible: e.isDownloadCountVisible,
		previewUrl,
		isHlsTar: isHlsTarMime(e.mimeType),
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
        <button v-if="isTargz" type="button" class="btn btn-primary" :disabled="archiveDownloadProgress != null" @click="startFullArchiveDownload(false)">
          <Download :size="16" :stroke-width="2" aria-hidden="true" />
          ダウンロード (.tar.gz)
        </button>
        <a v-else :href="downloadUrl" download class="btn btn-primary">
          <Download :size="16" :stroke-width="2" aria-hidden="true" />
          ダウンロード
        </a>
        <button v-if="isTargz" type="button" class="btn btn-secondary" :disabled="archiveDownloadProgress != null" @click="startFullArchiveDownload(true)">
          <PackageOpen :size="16" :stroke-width="2" aria-hidden="true" />
          展開してダウンロード (.tar)
        </button>
        <button type="button" class="btn btn-secondary" :disabled="archiveDownloadProgress != null" @click="startArchiveToZipDownload">
          <FileArchive :size="16" :stroke-width="2" aria-hidden="true" />
          zipとしてダウンロード
        </button>
        <Button.Root v-if="authStore.user" class="btn btn-ghost-danger" @click="archiveDeleteDialog = true">
          <Button.Content>
            <Trash2 :size="16" :stroke-width="2" aria-hidden="true" />
            削除
          </Button.Content>
        </Button.Root>
        <span v-if="deleteError" :class="[$style.inlineError, 'alert', 'alert-error']">{{ deleteError }}</span>
      </template>

      <!-- 通常ディレクトリ操作 -->
      <template v-if="!isArchive && authStore.user">
        <Button.Root class="btn btn-primary" @click="goUpload">
          <Button.Content>
            <Upload :size="16" :stroke-width="2" aria-hidden="true" />
            アップロード
          </Button.Content>
        </Button.Root>
        <button type="button" class="btn btn-secondary" :disabled="!bucketId" @click="openMkdirDialog">
          <FolderPlus :size="16" :stroke-width="2" aria-hidden="true" />
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
          <CheckCheck :size="16" :stroke-width="2" aria-hidden="true" />
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
              <Button.Root class="btn btn-ghost w-full" :class="$style.menuItem" @click="clearSelection">
                <Button.Content>
                  <X :size="16" :stroke-width="2" aria-hidden="true" />
                  選択を解除
                </Button.Content>
              </Button.Root>
              <div class="action-menu-divider" role="separator" />
              <Button.Root class="btn btn-ghost w-full" :class="$style.menuItem" :disabled="archiveDownloadProgress != null" @click="startDirectoryArchiveDownload('tar')">
                <Button.Content>
                  <Archive :size="16" :stroke-width="2" aria-hidden="true" />
                  tarとしてダウンロード
                </Button.Content>
              </Button.Root>
              <Button.Root class="btn btn-ghost w-full" :class="$style.menuItem" :disabled="archiveDownloadProgress != null" @click="startDirectoryArchiveDownload('zip')">
                <Button.Content>
                  <FileArchive :size="16" :stroke-width="2" aria-hidden="true" />
                  zipとしてダウンロード
                </Button.Content>
              </Button.Root>
              <div class="action-menu-divider" role="separator" />
              <Button.Root v-if="canUpdateSelectedListing" class="btn btn-ghost w-full" :class="$style.menuItem" @click="executeBulkUpdateListing(true)">
                <Button.Content>
                  <Eye :size="16" :stroke-width="2" aria-hidden="true" />
                  一覧に表示
                </Button.Content>
              </Button.Root>
              <Button.Root v-if="canUpdateSelectedListing" class="btn btn-ghost w-full" :class="$style.menuItem" @click="executeBulkUpdateListing(false)">
                <Button.Content>
                  <EyeOff :size="16" :stroke-width="2" aria-hidden="true" />
                  一覧から非表示
                </Button.Content>
              </Button.Root>
              <div v-if="canDeleteSelectedEntries || canUpdateSelectedModeration" class="action-menu-divider" role="separator" />
              <Button.Root v-if="canDeleteSelectedEntries" class="btn btn-ghost-danger w-full" :class="$style.menuItem" @click="requestBulkDelete">
                <Button.Content>
                  <Trash2 :size="16" :stroke-width="2" aria-hidden="true" />
                  まとめて削除
                </Button.Content>
              </Button.Root>
              <Button.Root v-if="canUpdateSelectedModeration" class="btn btn-ghost-danger w-full" :class="$style.menuItem" @click="requestBulkModerationForcedPrivate(true)">
                <Button.Content>
                  <ShieldOff :size="16" :stroke-width="2" aria-hidden="true" />
                  まとめて強制非公開
                </Button.Content>
              </Button.Root>
              <Button.Root v-if="canUpdateSelectedModeration" class="btn btn-ghost w-full" :class="$style.menuItem" @click="requestBulkModerationForcedPrivate(false)">
                <Button.Content>
                  <ShieldCheck :size="16" :stroke-width="2" aria-hidden="true" />
                  強制非公開をまとめて解除
                </Button.Content>
              </Button.Root>
            </div>
          </Popover.Content>
        </Popover.Root>
      </template>
    </div>

    <AdSlot :owner-can-disable-file-ads="effectiveOwnerCanDisableFileAds" />

    <div :class="$style.viewToggle" aria-label="表示形式">
      <div v-if="isArchive && archivePath !== ''" class="mb-2">
        <button :class="$style.upButton" type="button" @click="navigateArchiveUp">..</button>
      </div>
      <div v-else-if="parentPath()" class="mb-2">
        <NirA :to="parentPath()!" :class="$style.upLink">..</NirA>
      </div>

      <button
        :class="['ms-auto', $style.viewToggleButton, $style.viewListButton, viewMode === 'list' && $style.viewToggleButtonActive]"
        type="button"
        title="リストビュー"
        @click="setViewMode('list')"
      >
        <List class="inline-icon" :size="16" :stroke-width="2" />
        <span>リスト</span>
      </button>
      <button
        :class="[$style.viewToggleButton, $style.viewGridButton, viewMode === 'grid' && $style.viewToggleButtonActive]"
        type="button"
        title="グリッドビュー"
        @click="setViewMode('grid')"
      >
        <LayoutGrid class="inline-icon" :size="16" :stroke-width="2" />
        <span>グリッド</span>
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
                <th v-if="!isArchive" class="col-right">DL</th>
                <th>種類</th>
                <th v-if="!isArchive && authStore.user">公開</th>
                <th v-if="!isArchive && authStore.user && bucketId" class="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in entries" :key="entry.key" :class="entry.isDir && $style.directoryRow">
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
                    <Folder v-if="entry.isDir" :class="$style.folderIcon" :size="16" :stroke-width="2" aria-hidden="true" />
                    <FileVideo v-else-if="entry.isHlsTar" :class="$style.fileTypeIcon" :size="16" :stroke-width="2" aria-hidden="true" />
                    {{ entry.name }}
                  </NirA>
                </td>
                <td :class="[$style.sizeCell, 'col-right', 'col-muted']">
                  {{ entry.size != null ? formatSize(entry.size) : '' }}
                </td>
                <td v-if="!isArchive" :class="[$style.sizeCell, 'col-right', 'col-muted']">
                  {{ !entry.isDir && entry.downloadCount != null ? entry.downloadCount.toLocaleString() : '' }}
                </td>
                <td :class="$style.labelCell">
                  <span v-if="entry.label" :class="entry.isHlsTar ? ['badge', $style.hlsTarBadge] : ['badge', 'badge-muted']">{{ entry.label }}</span>
                </td>
                <td v-if="!isArchive && authStore.user" :class="$style.publicCell">
                  <div :class="$style.publicBadges">
                    <span v-if="!entry.isDir && entry.visibility != null" :class="entry.visibility === 'public' ? 'badge badge-success' : entry.visibility === 'passphrase' ? 'badge badge-warning' : 'badge badge-muted'">
                      {{ entry.visibility === 'public' ? '公開' : entry.visibility === 'passphrase' ? '合言葉' : '非公開' }}
                    </span>
                    <span v-if="entry.isListed != null" :class="entry.isListed ? 'badge badge-info' : 'badge badge-muted'">
                      {{ entry.isListed ? '表示' : '非表示' }}
                    </span>
                    <span v-if="entry.isModerationForcedPrivate" class="badge badge-danger">強制非公開</span>
                  </div>
                </td>
                <td v-if="!isArchive && authStore.user && bucketId" class="col-actions" :class="$style.actionsCell">
                  <Popover.Root>
                    <Popover.Activator
                      :class="['btn', 'btn-ghost', 'btn-icon', $style.entryMenuButton]"
                      :aria-label="`${entry.name}の操作`"
                    >
                      <EllipsisVertical :size="16" :stroke-width="2" aria-hidden="true" />
                    </Popover.Activator>
                    <Popover.Content class="action-menu">
                      <div class="action-menu-inner">
                        <Button.Root v-if="entry.isListed !== true" class="btn btn-ghost w-full" :class="$style.menuItem" @click="executeEntryUpdateListing(entry, true)">
                          <Button.Content>
                            <Eye :size="16" :stroke-width="2" aria-hidden="true" />
                            一覧に表示
                          </Button.Content>
                        </Button.Root>
                        <Button.Root v-if="entry.isListed !== false" class="btn btn-ghost w-full" :class="$style.menuItem" @click="executeEntryUpdateListing(entry, false)">
                          <Button.Content>
                            <EyeOff :size="16" :stroke-width="2" aria-hidden="true" />
                            一覧から非表示
                          </Button.Content>
                        </Button.Root>
                        <Button.Root class="btn btn-ghost w-full" :class="$style.menuItem" @click="requestMoveEntry(entry)">
                          <Button.Content>
                            <TextCursorInput :size="16" :stroke-width="2" aria-hidden="true" />
                            移動/名前変更
                          </Button.Content>
                        </Button.Root>
                        <Button.Root class="btn btn-ghost-danger w-full" :class="$style.menuItem" @click="requestDeleteEntry(entry)">
                          <Button.Content>
                            <Trash2 :size="16" :stroke-width="2" aria-hidden="true" />
                            削除
                          </Button.Content>
                        </Button.Root>
                        <div class="action-menu-divider" role="separator" />
                        <Button.Root v-if="((authStore.user?.isAdmin ?? false) || (authStore.user?.isModerator ?? false)) && !entry.isDir && entry.fileId && !entry.isModerationForcedPrivate" class="btn btn-ghost-danger w-full" :class="$style.menuItem" @click="executeEntryUpdateModerationForcedPrivate(entry, true)">
                          <Button.Content>
                            <ShieldOff :size="16" :stroke-width="2" aria-hidden="true" />
                            強制非公開
                          </Button.Content>
                        </Button.Root>
                        <Button.Root v-if="((authStore.user?.isAdmin ?? false) || (authStore.user?.isModerator ?? false)) && !entry.isDir && entry.fileId && entry.isModerationForcedPrivate" class="btn btn-ghost w-full" :class="$style.menuItem" @click="executeEntryUpdateModerationForcedPrivate(entry, false)">
                          <Button.Content>
                            <ShieldCheck :size="16" :stroke-width="2" aria-hidden="true" />
                            強制非公開を解除
                          </Button.Content>
                        </Button.Root>
                      </div>
                    </Popover.Content>
                  </Popover.Root>
                </td>
              </tr>
              <tr v-if="entries.length === 0">
                <td :colspan="tableColspan">
                  <div class="empty-state">
                    <p>エントリがありません。</p>
                  </div>
                </td>
              </tr>
              <InfiniteTableRow
                v-if="!isArchive && (directoryHasMore || loadingMore)"
                :colspan="tableColspan"
                :has-more="directoryHasMore"
                :loading="loadingMore"
                @load-more="loadMoreDirectory"
              />
            </tbody>
          </table>
          </div>
        </div>
        <template v-else>
          <div v-if="entries.length === 0" class="empty-state card">
            <p>エントリがありません。</p>
          </div>
          <div v-else :class="$style.gridView">
            <div
              v-for="entry in entries"
              :key="entry.key"
              :class="[$style.gridCard, entry.isDir && $style.directoryGridCard, isEntrySelected(entry) && $style.gridCardSelected]"
            >
              <button
                v-if="isArchive && entry.isDir"
                :class="$style.gridCardLink"
                type="button"
                :aria-label="entry.name"
                @click="navigateArchiveDir(entry.fullPath)"
              />
              <NirA
                v-else
                :to="entry.link"
                :class="$style.gridCardLink"
                :aria-label="entry.name"
              />
              <div v-if="!isArchive" :class="$style.gridCheckboxCell">
                <input
                  type="checkbox"
                  :class="$style.checkbox"
                  :checked="isEntrySelected(entry)"
                  :disabled="!canSelectEntries"
                  @change="toggleSelect(entry.fullPath)"
                >
              </div>
              <div
                :class="[$style.gridCardPreview, isArchive && entry.isDir ? $style.gridCardPreviewButton : '']"
                type="button"
              >
                <img
                  v-if="entry.previewUrl"
                  :src="entry.previewUrl"
                  :alt="entry.name"
                  :class="$style.gridCardImage"
                  width="300"
                  height="300"
                  loading="lazy"
                  decoding="async"
                >
                <div v-else :class="$style.gridCardIcon">
                  <Folder v-if="entry.isDir" :size="42" :stroke-width="1.8" aria-hidden="true" />
                  <FileVideo v-else-if="entry.isHlsTar" :size="38" :stroke-width="1.8" aria-hidden="true" />
                  <FileIcon v-else :size="34" :stroke-width="1.8" aria-hidden="true" />
                </div>
              </div>
              <div :class="$style.gridCardInfo">
                <div :class="$style.gridCardName" :title="entry.name">{{ entry.name }}</div>
                <div :class="$style.gridCardMeta">
                  <span v-if="entry.size != null" :class="$style.gridCardSize">{{ formatSize(entry.size) }}</span>
                  <span v-if="!entry.isDir && entry.downloadCount != null" class="badge badge-info">DL {{ entry.downloadCount.toLocaleString() }}</span>
                  <span v-if="entry.label" :class="entry.isHlsTar ? ['badge', $style.hlsTarBadge] : ['badge', 'badge-muted']">{{ entry.label }}</span>
                  <span v-if="!entry.isDir && entry.visibility != null && !isArchive" :class="entry.visibility === 'public' ? 'badge badge-success' : entry.visibility === 'passphrase' ? 'badge badge-warning' : 'badge badge-muted'">
                    {{ entry.visibility === 'public' ? '公開' : entry.visibility === 'passphrase' ? '合言葉' : '非公開' }}
                  </span>
                  <span v-if="entry.isListed != null && !isArchive" :class="entry.isListed ? 'badge badge-info' : 'badge badge-muted'">
                    {{ entry.isListed ? '表示' : '非表示' }}
                  </span>
                  <span v-if="entry.isModerationForcedPrivate && !isArchive" class="badge badge-danger">強制非公開</span>
                </div>
                <div v-if="!isArchive && authStore.user && bucketId" :class="$style.gridCardActions">
                  <a
                    v-if="!entry.isDir && entry.fileId && entry.visibility === 'public' && entry.isModerationForcedPrivate !== true"
                    :href="`/d/${entry.fileId}`"
                    download
                    :class="['btn', 'btn-ghost', $style.gridCardActionButton, $style.gridCardDownloadButton]"
                    :aria-label="`${entry.name}をダウンロード`"
                    title="ダウンロード"
                    @click.stop
                  >
                    <Download :size="16" :stroke-width="2" aria-hidden="true" />
                  </a>
                  <Button.Root
                    v-else-if="entry.isDir"
                    class="btn btn-ghost"
                    :class="[$style.gridCardActionButton, $style.gridCardDownloadButton]"
                    :disabled="archiveDownloadProgress != null"
                    :aria-label="`${entry.name}をダウンロード`"
                    title="ダウンロード"
                    @click="(event: Event) => { stopGridActionEvent(event); startEntryArchiveDownload(entry); }"
                  >
                    <Button.Content>
                      <Download :size="16" :stroke-width="2" aria-hidden="true" />
                    </Button.Content>
                  </Button.Root>
                  <Button.Root
                    v-else
                    class="btn btn-ghost"
                    :class="[$style.gridCardActionButton, $style.gridCardDownloadButton]"
                    disabled
                    aria-label="ダウンロード不可"
                    title="ダウンロード不可"
                  >
                    <Button.Content>
                      <Download :size="16" :stroke-width="2" aria-hidden="true" />
                    </Button.Content>
                  </Button.Root>

                  <Button.Root
                    class="btn btn-ghost"
                    :class="[$style.gridCardActionButton, $style.gridCardIconButton]"
                    :aria-label="entry.isListed === false ? `${entry.name}を一覧に表示` : `${entry.name}を一覧から非表示`"
                    :title="entry.isListed === false ? '一覧に表示' : '一覧から非表示'"
                    @click="(event: Event) => executeEntryUpdateListing(entry, entry.isListed === false, event)"
                  >
                    <Button.Content>
                      <Eye v-if="entry.isListed !== false" :size="16" :stroke-width="2" aria-hidden="true" />
                      <EyeOff v-else :size="16" :stroke-width="2" aria-hidden="true" />
                    </Button.Content>
                  </Button.Root>

                  <Button.Root
                    class="btn btn-ghost"
                    :class="[$style.gridCardActionButton, $style.gridCardIconButton]"
                    :aria-label="`${entry.name}を移動または名前変更`"
                    title="移動/名前変更"
                    @click="(event: Event) => requestMoveEntry(entry, event)"
                  >
                    <Button.Content>
                      <TextCursorInput :size="16" :stroke-width="2" aria-hidden="true" />
                    </Button.Content>
                  </Button.Root>

                  <Button.Root
                    v-if="((authStore.user?.isAdmin ?? false) || (authStore.user?.isModerator ?? false)) && !entry.isDir && entry.fileId"
                    class="btn"
                    :class="[entry.isModerationForcedPrivate ? 'btn-ghost' : 'btn-ghost-danger', $style.gridCardActionButton, $style.gridCardIconButton]"
                    :aria-label="entry.isModerationForcedPrivate ? `${entry.name}の強制非公開を解除` : `${entry.name}を強制非公開`"
                    :title="entry.isModerationForcedPrivate ? '強制非公開を解除' : '強制非公開'"
                    @click="(event: Event) => executeEntryUpdateModerationForcedPrivate(entry, !entry.isModerationForcedPrivate, event)"
                  >
                    <Button.Content>
                      <EyeOff :size="16" :stroke-width="2" aria-hidden="true" />
                    </Button.Content>
                  </Button.Root>

                  <Button.Root
                    class="btn btn-ghost-danger"
                    :class="[$style.gridCardActionButton, $style.gridCardIconButton]"
                    :aria-label="`${entry.name}を削除`"
                    title="削除"
                    @click="(event: Event) => { stopGridActionEvent(event); requestDeleteEntry(entry); }"
                  >
                    <Button.Content>
                      <Trash2 :size="16" :stroke-width="2" aria-hidden="true" />
                    </Button.Content>
                  </Button.Root>
                </div>
              </div>
            </div>
          </div>
        </template>
        <InfiniteLoadTrigger
          v-if="!isArchive && viewMode !== 'list' && (directoryHasMore || loadingMore)"
          :has-more="directoryHasMore"
          :loading="loadingMore"
          @load-more="loadMoreDirectory"
        />
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

    <!-- 強制非公開確認ダイアログ（エントリ） -->
    <ConfirmDialog
      v-model:open="moderationDialog"
      :title="moderationValue ? 'ファイルを強制非公開' : '強制非公開を解除'"
      :message="moderationTarget ? (moderationValue ? `ファイル「${moderationTarget.name}」を強制非公開にしますか？` : `ファイル「${moderationTarget.name}」の強制非公開を解除しますか？`) : ''"
      :confirm-label="moderationValue ? '強制非公開にする' : '解除する'"
      :danger="moderationValue"
      @confirm="confirmEntryUpdateModerationForcedPrivate"
      @cancel="moderationDialog = false"
    />

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

    <ConfirmDialog
      v-if="canUpdateSelectedModeration"
      v-model:open="bulkModerationDialog"
      :title="bulkModerationValue ? '複数ファイルを強制非公開' : '強制非公開をまとめて解除'"
      :message="bulkModerationValue ? `選択した ${selectedFileEntries.length} 件のファイルを強制非公開にしますか？` : `選択した ${selectedFileEntries.length} 件のファイルの強制非公開を解除しますか？`"
      :confirm-label="bulkModerationValue ? '強制非公開にする' : '解除する'"
      :danger="bulkModerationValue"
      @confirm="executeBulkUpdateModerationForcedPrivate"
      @cancel="bulkModerationDialog = false"
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

    <MoveEntryDialog
      v-if="authStore.user && moveTarget"
      v-model:open="moveDialog"
      :type="moveTarget.isDir ? 'directory' : 'file'"
      :source-bucket-id="bucketId"
      :source-bucket-name="bucketName"
      :source-path="moveTarget.fullPath"
      @moved="handleEntryMoved"
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
  color: var(--color-success);
  border-color: transparent;
}

.selectAllButton:hover {
  color: #fff;
  background: var(--color-success);
}

:global([data-theme="dark"]) .selectAllButton {
  color: var(--color-success);
}

:global([data-theme="dark"]) .selectAllButton:hover {
  color: var(--color-directory-surface);
  background: var(--color-success);
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
  display: flex;
  align-items: center;
  gap: 0.5em;
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

.viewListButton {
  border-radius: 6px 0 0 6px;
}

.viewGridButton {
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
  accent-color: var(--color-success-muted);
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
  border: 1px solid var(--color-border, #d5dbe3);
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
  border: 1px solid var(--color-border, #d5dbe3);
  border-radius: 6px;
  text-decoration: none;
}

.upButton:hover,
.upLink:hover {
  color: #fff;
  background: var(--color-primary);
  text-decoration: none;
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

.fileTypeIcon {
  flex: 0 0 auto;
  margin-right: 4px;
  color: var(--color-primary);
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

.hlsTarBadge {
  color: #0f4a64;
  background: #dff4fb;
  border: 1px solid #a9d8e8;
}

.publicCell {
  white-space: nowrap;
}

.publicBadges {
  display: flex;
  gap: 6px;
  flex-wrap: nowrap;
  align-items: center;
}

.actionsCell {
  white-space: nowrap;
}

.directoryRow {
  background: var(--color-directory-surface);
}

.directoryRow:hover {
  background: var(--color-directory-surface-hover);
}

.gridView {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(175px, 1fr));
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

.directoryGridCard {
  background: var(--color-directory-surface);
  border-color: var(--color-directory-border);
}

.gridCardSelected {
  border-color: var(--color-border, #e0e0e0);
}

.gridCardSelected::after {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  content: "";
  border: 2px solid var(--color-primary);
  border-radius: 7px;
}

.gridCardLink {
  position: absolute;
  inset: 0;
  z-index: 1;
  padding: 0;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
}

.gridCheckboxCell {
  position: absolute;
  z-index: 3;
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
  height: 175px;
  color: var(--color-text-muted);
  text-decoration: none;
  background: var(--color-bg);
}

.directoryGridCard .gridCardPreview {
  background: var(--color-directory-surface-hover);
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
  background: var(--color-bg);
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
  height: 100%;
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
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: auto;
  padding-top: 2px;
  flex-wrap: wrap;
  justify-content: end;
}

.gridCardActionButton {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  justify-content: center;
  padding-block: 4px;
  line-height: 1;
}

.gridCardActionButton :global(svg) {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
}

.gridCardActionButton :global([data-v0-button-content]) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
}

.gridCardDownloadButton {
  flex: 1 1 auto;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  border-color: transparent;
}

.gridCardDownloadButton:hover {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 20%, transparent);
  border-color: transparent;
}

.gridCardIconButton {
  flex: 0 0 32px;
  width: 32px;
  padding-inline: 0;
}
</style>
