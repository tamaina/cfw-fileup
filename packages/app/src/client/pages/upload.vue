<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, type Component } from 'vue';
import type { FileVisibility } from '../../shared/file-visibility';
import { Button, Dialog, Popover } from '@vuetify/v0';
import { EllipsisVertical, File, FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo, Folder, FolderOpen, GripVertical, Pencil } from '@lucide/vue';
import { authHeaders, authStore } from '../store/auth';
import { apiPost } from '../utils/api';
import NirA from '@/components/NirA.vue';
import { TarArchiver, BgzfTarArchiver, type TarIndex, type TarGzIndex, type ArchiveProgress } from 'bgzf';
import { takePendingUpload } from '@/store/pending-upload';
import UploadDestinationDialog from '@/components/UploadDestinationDialog.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import FileVisibilitySettings from '@/components/FileVisibilitySettings.vue';
import { MAX_FILE_PATH_LENGTH } from '../../shared/const';
import { isValidFilePath } from '../../shared/name-validation';
import { UploadTree, type UploadDirectory, type UploadEntry } from '@/utils/upload-tree';
import { enqueueUploadJob, uploadWorkerJobs } from '@/store/upload-worker';
import { buildUploadConflictDirectoryPlan, findUploadConflictsInDirectory, getEffectiveUploadEntries, isPathUnderMissingDirectory } from '@/utils/upload-paths';
import { takeShareTargetPayload } from '../../shared/share-target-store';
import { readBlobTextPreview } from '@/utils/text-preview';
import { formatBytes } from '@/utils/byte-size';
import type { ZipExtractWorkerMessage } from '@/workers/zip-extract.worker';
import type { UploadWorkerFileEntry } from '@/workers/upload-worker-types';
import { navigateTo } from '@/navigate';
import { browserUploadAutoOpen, browserUploadNonResumeLimitBytes, browserUploadPartSizeBytes } from '@/store/browser-upload-settings';

type ArchiveMode = 'individual' | 'gz' | 'tar' | 'targz';

interface Bucket {
	id: string;
	name: string;
	usedBytes: number;
}

/** デフォルトのチャンクサイズ: 32MiB
 * R2のマルチパートアップロードはパートごとにClass A操作となるため、
 * コストを抑えるためにデフォルトを大きく設定する。
 * サーバーからpartSizeが返された場合はそちらを優先する。
 */
const DEFAULT_CHUNK_SIZE = 32 * 1024 * 1024;

const buckets = ref<Bucket[]>([]);
const selectedBucketName = ref('');
const destinationDialogOpen = ref(false);
const bucket = computed(() => buckets.value.find(b => b.name === selectedBucketName.value) ?? null);
const maxBucketSizeBytes = ref<number | null>(null);
const loadError = ref('');

const selectedTree = ref<UploadTree | null>(null);
const selectedEntry = ref<UploadEntry | null>(null);
const uploadPrefix = ref('');
const archiveMode = ref<ArchiveMode>('individual');
const archiveModeTouched = ref(false);
const compressImagesOnUpload = ref(false);
const imageCompressionDialogOpen = ref(false);
const imageCompressionMimeType = ref<'image/webp' | 'image/jpeg'>('image/webp');
const canEncodeWebp = ref(true);
const imageCompressionQuality = ref(0.7);
const imageCompressionMaxWidth = ref(1920);
const imageCompressionMaxHeight = ref(1920);
const libraryName = ref('');
const visibility = ref<FileVisibility>('public');
const isListed = ref(true);
const passphrase = ref('');
const isDownloadCountEnabled = ref(false);
const isDownloadCountVisible = ref(false);
const canUseDownloadCount = ref(false);
const isDragOver = ref(false);
const selectionError = ref('');
const previewUrl = ref('');
const previewText = ref('');
const previewLoading = ref(false);
const fileRowElements = ref(new Map<string, HTMLButtonElement>());
const draggingItem = ref<DraggingUploadItem | null>(null);
const dragOverDirectoryPath = ref<string | null>(null);
const dragPointerId = ref<number | null>(null);
const dragPreviewX = ref(0);
const dragPreviewY = ref(0);
let previousBodyCursor = '';
const uploadError = ref('');
const uploadDone = ref(false);
const redirectUploadJobId = ref<string | null>(null);
const quotaWarningOpen = ref(false);
const quotaWarningConfirmed = ref(false);
const zipConfirmOpen = ref(false);
const zipConfirmFileName = ref('');
const zipPasswordOpen = ref(false);
const zipPasswordFileName = ref('');
const zipPassword = ref('');
const zipPasswordError = ref('');
const zipExtractingOpen = ref(false);
const zipExtractingFileName = ref('');
const zipExtractingCurrentFileName = ref('');
const zipExtractingFileIndex = ref(0);
const zipExtractingTotalFiles = ref(0);
const zipWarnings = ref<string[]>([]);
let zipConfirmResolve: ((value: boolean) => void) | null = null;
let zipPasswordResolve: ((value: string | null) => void) | null = null;
let zipExtractWorker: Worker | null = null;
let zipExtractRequestId = 0;
const zipExtractRequests = new Map<string, {
	resolve: (value: ZipExtractDoneResult) => void;
	reject: (reason?: unknown) => void;
}>();

interface ZipExtractDoneResult {
	entries: { path: string; file: File }[];
	warnings: string[];
	needsPassword: boolean;
}

async function detectWebpEncodingSupport(): Promise<boolean> {
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(1, 1);
		const blob = await canvas.convertToBlob({ type: 'image/webp' }).catch(() => null);
		if (blob?.type === 'image/webp') return true;
	}
	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp'));
	return blob?.type === 'image/webp';
}

function shouldCompressImagePath(entry: UploadWorkerFileEntry): boolean {
	return compressImagesOnUpload.value && archiveMode.value === 'individual' && entry.file.type.startsWith('image/');
}

function isCompressedImageEntry(entry: UploadEntry): boolean {
	return entry.type.startsWith('image/') && entry.type !== 'image/bmp';
}

function compressedImageUploadPath(path: string): string {
	const extension = imageCompressionMimeType.value === 'image/webp' ? '.webp' : '.jpg';
	const dot = path.lastIndexOf('.');
	const slash = path.lastIndexOf('/');
	if (dot > slash) return `${path.slice(0, dot)}${extension}`;
	return `${path}${extension}`;
}

function getUploadPaths(entries: readonly UploadWorkerFileEntry[] | null = selectedTree.value?.entries ?? null): string[] {
	if (!entries) return [];
	if (archiveMode.value === 'tar') return [`${uploadPrefix.value}${archiveUploadBaseName.value}.tar`];
	if (archiveMode.value === 'targz') return [`${uploadPrefix.value}${archiveUploadBaseName.value}.tar.gz`];
	return entries.map(entry =>
		archiveMode.value === 'gz'
			? `${uploadPrefix.value}${entry.path}.gz`
			: `${uploadPrefix.value}${shouldCompressImagePath(entry) ? compressedImageUploadPath(entry.path) : entry.path}`,
	);
}

function validateUploadPaths(paths: string[]): boolean {
	if ((archiveMode.value === 'tar' || archiveMode.value === 'targz') && /[\\/]/.test(archiveUploadBaseName.value)) {
		uploadError.value = 'ライブラリ名に / または \\ は使えません。';
		return false;
	}
	const invalidPath = paths.find(path => !isValidFilePath(path));
	if (invalidPath) {
		uploadError.value = `パスに使用できない名前が含まれています: ${invalidPath}`;
		return false;
	}
	const tooLongPath = paths.find(path => path.length > MAX_FILE_PATH_LENGTH);
	if (tooLongPath) {
		uploadError.value = `パスは${MAX_FILE_PATH_LENGTH}文字以内で入力してください: ${tooLongPath}`;
		return false;
	}
	const seen = new Set<string>();
	const duplicatePath = paths.find(path => {
		if (seen.has(path)) return true;
		seen.add(path);
		return false;
	});
	if (duplicatePath) {
		uploadError.value = `同じアップロード先になるファイルがあります: ${duplicatePath}`;
		return false;
	}
	return true;
}

const hasSelection = computed(() => selectedTree.value != null && selectedTree.value.entries.length > 0);
const archiveBaseName = computed(() => {
	if (!selectedTree.value) return 'archive';
	if (selectedTree.value.hasDirectories && selectedTree.value.rootName) return selectedTree.value.rootName;
	return selectedTree.value.entries[0]?.name.replace(/\.[^.]*$/, '') || 'archive';
});
const archiveUploadBaseName = computed(() => libraryName.value.trim() || archiveBaseName.value);
const flatDisplayEntries = computed(() => selectedTree.value ? flattenDirectory(selectedTree.value.root) : []);
const directoryDropEntries = computed<DirectoryDropEntry[]>(() => {
	const directories = flatDisplayEntries.value.filter((entry): entry is FlatDisplayDirectory => entry.type === 'dir');
	const entries: DirectoryDropEntry[] = [
		{ type: 'root', key: 'dir:', name: 'アップロードルート', path: '', depth: 0 },
		...directories,
	];
	const item = draggingItem.value;
	if (item?.type !== 'dir') return entries;
	return entries.filter(entry => entry.path !== item.directory.path && !entry.path.startsWith(item.directory.path));
});
const draggingSourceDirectoryPath = computed(() => {
	const item = draggingItem.value;
	if (!item) return null;
	return item.type === 'file' ? item.entry.parentPath : getDirectoryParentPath(item.directory.path);
});
const draggingItemName = computed(() => {
	const item = draggingItem.value;
	if (!item) return '';
	return item.type === 'file' ? item.entry.name : item.directory.name;
});
const selectedUploadBytes = computed(() => selectedTree.value?.totalSize ?? 0);
const compressedImageEntries = computed(() => selectedTree.value?.entries.filter(isCompressedImageEntry) ?? []);
const shouldRecommendTarForCompressedImages = computed(() => compressedImageEntries.value.length >= 3);
const tarRecommendationMessage = computed(() => {
	const count = compressedImageEntries.value.length;
	return `画像が${count}枚あります。再圧縮しても容量が減りにくいため、tarにまとめるのがおすすめです。`;
});
const quotaRemainingBytes = computed(() => {
	if (!bucket.value || maxBucketSizeBytes.value === null) return null;
	return Math.max(0, maxBucketSizeBytes.value - bucket.value.usedBytes);
});
const isQuotaWarningNeeded = computed(() => (
	bucket.value != null
	&& maxBucketSizeBytes.value !== null
	&& selectedUploadBytes.value > quotaRemainingBytes.value!
));
const quotaWarningMessage = computed(() => {
	if (!bucket.value || maxBucketSizeBytes.value === null || quotaRemainingBytes.value === null) return '';
	return [
		`選択中のファイルは約 ${formatBytes(selectedUploadBytes.value)} です。`,
		`アップロード先バケットの残り容量は ${formatBytes(quotaRemainingBytes.value)} です。`,
		'圧縮後サイズによっては成功する場合もありますが、クォータ超過で失敗する可能性があります。',
	].join('\n');
});
const previewKind = computed(() => {
	const entry = selectedEntry.value;
	if (!entry) return 'empty';
	if (entry.type.startsWith('image/')) return 'image';
	if (entry.type.startsWith('video/')) return 'video';
	if (entry.type.startsWith('audio/')) return 'audio';
	if (entry.type === 'application/pdf') return 'pdf';
	if (isTextLike(entry)) return 'text';
	return 'meta';
});

function browserUploadLink(bucketName: string, path: string): string {
	return `/v/${bucketName}/${path}`;
}

watch(uploadWorkerJobs, jobs => {
	const jobId = redirectUploadJobId.value;
	if (!jobId) return;
	const job = jobs.find(current => current.id === jobId);
	if (!job || job.status !== 'done' || !job.completedPath) return;
	redirectUploadJobId.value = null;
	if (browserUploadAutoOpen.value && window.location.pathname === '/uploader') {
		navigateTo(browserUploadLink(job.bucketName, job.completedPath));
	}
});

function getEffectiveSelectedFileEntries() {
	const tree = selectedTree.value;
	if (!tree) return [];
	const shouldTrimSingleRoot = libraryName.value.trim() === '' && (archiveMode.value === 'tar' || archiveMode.value === 'targz');
	return getEffectiveUploadEntries(tree.entries, shouldTrimSingleRoot).entries;
}

async function loadBucket(): Promise<void> {
	const result = await apiPost('/api/buckets/list');
	if (!result.ok) {
		loadError.value = result.data.message;
		return;
	}
	buckets.value = result.data.buckets;
	maxBucketSizeBytes.value = result.data.maxBucketSizeBytes;
	canUseDownloadCount.value = result.data.canUseDownloadCount;
	if (!canUseDownloadCount.value) {
		isDownloadCountEnabled.value = false;
		isDownloadCountVisible.value = false;
	}
	if (!selectedBucketName.value && buckets.value.length > 0) {
		selectedBucketName.value = buckets.value[0].name;
	}
}

async function handleFileInputChange(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	await selectFiles(input.files);
	input.value = '';
}

async function selectFiles(files: FileList | null): Promise<void> {
	if (!files || files.length === 0) return;
	try {
		await addSelectedTreeWithZipPrompts(await UploadTree.from(files));
	} catch (err) {
		selectionError.value = err instanceof Error ? err.message : String(err);
	}
}

async function handleDrop(event: DragEvent): Promise<void> {
	isDragOver.value = false;
	const data = event.dataTransfer;
	if (!data) return;
	try {
		await addSelectedTreeWithZipPrompts(await UploadTree.from(data));
	} catch (err) {
		selectionError.value = err instanceof Error ? err.message : String(err);
	}
}

async function setSelectedTree(tree: UploadTree, entryToSelect: UploadEntry | null = tree.entries[0] ?? null): Promise<void> {
	selectionError.value = '';
	uploadError.value = '';
	uploadDone.value = false;
	redirectUploadJobId.value = null;
	selectedTree.value = tree;
	selectEntry(entryToSelect);
	if (archiveMode.value === 'gz' && tree.hasDirectories) archiveMode.value = 'individual';
	if (!archiveModeTouched.value && shouldRecommendTarForCompressedImages.value) archiveMode.value = 'tar';
}

async function addSelectedTree(tree: UploadTree): Promise<void> {
	if (!selectedTree.value) {
		await setSelectedTree(tree);
		return;
	}

	const entriesByPath = new Map<string, UploadEntry>();
	for (const entry of selectedTree.value.entries) entriesByPath.set(entry.path, entry);
	for (const entry of tree.entries) entriesByPath.set(entry.path, entry);
	const entries = Array.from(entriesByPath.values());
	const mergedTree = await UploadTree.from({
		entries,
		rootName: inferUploadRootName(entries.map(entry => entry.path)),
	});
	await setSelectedTree(mergedTree, tree.entries[0] ?? selectedEntry.value);
}

async function addSelectedTreeWithZipPrompts(tree: UploadTree): Promise<void> {
	const expanded = await expandZipEntriesInTree(tree);
	await addSelectedTree(await UploadTree.from({
		entries: expanded.entries,
		rootName: inferUploadRootName(expanded.entries.map(entry => entry.path)),
	}));
	zipWarnings.value = expanded.warnings;
}

async function consumeShareTargetPayload(): Promise<void> {
	const url = new URL(window.location.href);
	const shareTargetId = url.searchParams.get('shareTarget');
	if (!shareTargetId) return;

	url.searchParams.delete('shareTarget');
	window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);

	if (shareTargetId === 'empty') {
		selectionError.value = '共有されたファイルが見つかりませんでした。';
		return;
	}

	try {
		const payload = await takeShareTargetPayload(shareTargetId);
		if (!payload || payload.files.length === 0) {
			selectionError.value = '共有されたファイルを読み込めませんでした。もう一度共有してください。';
			return;
		}
		const entries = payload.files.map(entry => ({
			path: entry.name || entry.file.name,
			file: entry.file,
		}));
		await addSelectedTreeWithZipPrompts(await UploadTree.from({ entries }));
	} catch (err) {
		selectionError.value = err instanceof Error ? err.message : String(err);
	}
}

async function expandZipEntriesInTree(tree: UploadTree): Promise<{ entries: { path: string; file: File }[]; warnings: string[] }> {
	const entries: { path: string; file: File }[] = [];
	const warnings: string[] = [];
	for (const entry of tree.entries) {
		if (!isZipUploadEntry(entry)) {
			entries.push({ path: entry.path, file: entry.file });
			continue;
		}

		const shouldExtract = await confirmZipExtraction(entry.name);
		if (!shouldExtract) {
			entries.push({ path: entry.path, file: entry.file });
			continue;
		}

		let password: string | undefined;
		while (true) {
			try {
				startZipExtracting(entry.name);
				const result = await extractZipInWorker(entry.file, password);
				stopZipExtracting();
				if (result.needsPassword) {
					const nextPassword = await requestZipPassword(entry.name);
					if (nextPassword === null) {
						entries.push({ path: entry.path, file: entry.file });
						break;
					}
					password = nextPassword;
					continue;
				}
				entries.push(...result.entries);
				warnings.push(...result.warnings);
				break;
			} catch (err) {
				stopZipExtracting();
				if (err instanceof Error && err.message === 'invalid-password') {
					const nextPassword = await requestZipPassword(entry.name, 'パスワードが正しくありません。');
					if (nextPassword === null) {
						entries.push({ path: entry.path, file: entry.file });
						break;
					}
					password = nextPassword;
					continue;
				}
				throw err;
			}
		}
	}
	return { entries, warnings };
}

function isZipUploadEntry(entry: UploadEntry): boolean {
	return /\.zip$/i.test(entry.name) || entry.type === 'application/zip' || entry.type === 'application/x-zip-compressed';
}

function confirmZipExtraction(fileName: string): Promise<boolean> {
	zipConfirmFileName.value = fileName;
	zipConfirmOpen.value = true;
	return new Promise(resolve => {
		zipConfirmResolve = resolve;
	});
}

function resolveZipConfirm(value: boolean): void {
	zipConfirmOpen.value = false;
	zipConfirmResolve?.(value);
	zipConfirmResolve = null;
}

function requestZipPassword(fileName: string, error = ''): Promise<string | null> {
	zipPasswordFileName.value = fileName;
	zipPassword.value = '';
	zipPasswordError.value = error;
	zipPasswordOpen.value = true;
	return new Promise(resolve => {
		zipPasswordResolve = resolve;
	});
}

function submitZipPassword(): void {
	zipPasswordOpen.value = false;
	zipPasswordResolve?.(zipPassword.value);
	zipPasswordResolve = null;
}

function cancelZipPassword(): void {
	zipPasswordOpen.value = false;
	zipPasswordResolve?.(null);
	zipPasswordResolve = null;
}

function startZipExtracting(fileName: string): void {
	zipExtractingFileName.value = fileName;
	zipExtractingCurrentFileName.value = '';
	zipExtractingFileIndex.value = 0;
	zipExtractingTotalFiles.value = 0;
	zipExtractingOpen.value = true;
}

function stopZipExtracting(): void {
	zipExtractingOpen.value = false;
}

function extractZipInWorker(file: File, password?: string): Promise<ZipExtractDoneResult> {
	const worker = getZipExtractWorker();
	const id = String(++zipExtractRequestId);
	return new Promise((resolve, reject) => {
		zipExtractRequests.set(id, { resolve, reject });
		worker.postMessage({ id, file, password });
	});
}

function getZipExtractWorker(): Worker {
	if (zipExtractWorker) return zipExtractWorker;
	zipExtractWorker = new Worker(new URL('../workers/zip-extract.worker.ts', import.meta.url), { type: 'module' });
	zipExtractWorker.onmessage = (event: MessageEvent<ZipExtractWorkerMessage>) => {
		const message = event.data;
		if (message.type === 'progress') {
			zipExtractingCurrentFileName.value = message.progress.fileName;
			zipExtractingFileIndex.value = message.progress.fileIndex;
			zipExtractingTotalFiles.value = message.progress.totalFiles;
			return;
		}
		const pending = zipExtractRequests.get(message.id);
		if (!pending) return;
		zipExtractRequests.delete(message.id);
		if (message.type === 'done') {
			pending.resolve({ entries: message.entries, warnings: message.warnings, needsPassword: message.needsPassword });
		} else if (message.type === 'invalid-password') {
			pending.reject(new Error('invalid-password'));
		} else {
			pending.reject(new Error(message.error));
		}
	};
	return zipExtractWorker;
}

function clearSelectedTree(): void {
	selectedTree.value = null;
	selectEntry(null);
	archiveMode.value = 'individual';
	archiveModeTouched.value = false;
	selectionError.value = '';
	zipWarnings.value = [];
	uploadError.value = '';
	uploadDone.value = false;
	redirectUploadJobId.value = null;
}

function updateArchiveMode(mode: ArchiveMode): void {
	archiveModeTouched.value = true;
	archiveMode.value = mode;
}

async function removeSelectedEntry(path: string): Promise<void> {
	if (!selectedTree.value) return;
	const currentEntries = selectedTree.value.entries;
	const removeIndex = currentEntries.findIndex(entry => entry.path === path);
	if (removeIndex === -1) return;

	const entries = currentEntries.filter(entry => entry.path !== path);
	if (entries.length === 0) {
		clearSelectedTree();
		return;
	}

	const nextEntry = selectedEntry.value?.path === path
		? entries[Math.min(removeIndex, entries.length - 1)]
		: selectedEntry.value;
	const nextTree = await UploadTree.from({
		entries,
		rootName: inferUploadRootName(entries.map(entry => entry.path)),
	});
	await setSelectedTree(nextTree, nextEntry);
}

async function moveEntryToDirectory(entry: UploadEntry, targetDirectoryPath: string): Promise<void> {
	if (!selectedTree.value) return;
	const nextPath = `${targetDirectoryPath}${entry.name}`;
	if (nextPath === entry.path) return;

	const entries = selectedTree.value.entries
		.filter(current => current.path !== entry.path && current.path !== nextPath)
		.map(current => ({ path: current.path, file: current.file }));
	entries.push({ path: nextPath, file: entry.file });

	const nextTree = await UploadTree.from({
		entries,
		rootName: inferUploadRootName(entries.map(current => current.path)),
	});
	const movedEntry = nextTree.entries.find(current => current.path === nextPath) ?? null;
	await setSelectedTree(nextTree, movedEntry);
}

async function moveDirectoryToDirectory(directory: FlatDisplayDirectory, targetDirectoryPath: string): Promise<void> {
	if (!selectedTree.value) return;
	const nextPrefix = `${targetDirectoryPath}${directory.name}/`;
	if (nextPrefix === directory.path || targetDirectoryPath.startsWith(directory.path)) return;

	const selectedPath = selectedEntry.value?.path ?? null;
	const movedEntries = selectedTree.value.entries
		.filter(entry => entry.path.startsWith(directory.path))
		.map(entry => ({ path: `${nextPrefix}${entry.path.slice(directory.path.length)}`, file: entry.file }));
	const entries = selectedTree.value.entries
		.filter(entry => !entry.path.startsWith(directory.path) && !entry.path.startsWith(nextPrefix))
		.map(entry => ({ path: entry.path, file: entry.file }));
	entries.push(...movedEntries);

	const nextTree = await UploadTree.from({
		entries,
		rootName: inferUploadRootName(entries.map(entry => entry.path)),
	});
	const nextSelectedPath = selectedPath?.startsWith(directory.path)
		? `${nextPrefix}${selectedPath.slice(directory.path.length)}`
		: selectedPath;
	const nextSelectedEntry = nextTree.entries.find(entry => entry.path === nextSelectedPath) ?? nextTree.entries.find(entry => entry.path.startsWith(nextPrefix)) ?? null;
	await setSelectedTree(nextTree, nextSelectedEntry);
}

async function moveItemToDirectory(item: DraggingUploadItem, targetDirectoryPath: string): Promise<void> {
	if (item.type === 'file') {
		await moveEntryToDirectory(item.entry, targetDirectoryPath);
		return;
	}
	await moveDirectoryToDirectory(item.directory, targetDirectoryPath);
}

function getDirectoryParentPath(path: string): string {
	const parts = path.replace(/\/$/, '').split('/');
	parts.pop();
	return parts.length === 0 ? '' : `${parts.join('/')}/`;
}

function inferUploadRootName(paths: readonly string[]): string {
	if (paths.length === 0) return '';
	const first = paths[0].split('/')[0] ?? '';
	return paths.every(path => path.split('/')[0] === first) ? first : '';
}

interface FlatDisplayDirectory {
	type: 'dir';
	key: string;
	name: string;
	path: string;
	depth: number;
}

interface RootDropEntry {
	type: 'root';
	key: string;
	name: string;
	path: '';
	depth: 0;
}

interface FlatDisplayFile {
	type: 'file';
	key: string;
	entry: UploadEntry;
	depth: number;
}

type FlatDisplayEntry = FlatDisplayDirectory | FlatDisplayFile;
type DirectoryDropEntry = FlatDisplayDirectory | RootDropEntry;
type DraggingUploadItem =
	| { type: 'file'; entry: UploadEntry }
	| { type: 'dir'; directory: FlatDisplayDirectory };

function flattenDirectory(dir: UploadDirectory, depth = -1): FlatDisplayEntry[] {
	const result: FlatDisplayEntry[] = [];
	for (const child of dir.directories) {
		result.push({ type: 'dir', key: `dir:${child.path}`, name: child.name, path: child.path, depth: depth + 1 });
		result.push(...flattenDirectory(child, depth + 1));
	}
	for (const entry of dir.files) {
		result.push({ type: 'file', key: `file:${entry.path}`, entry, depth: depth + 1 });
	}
	return result;
}

function isTextLike(entry: UploadEntry): boolean {
	return entry.type.startsWith('text/')
		|| /(?:^|\/)(?:json|xml|javascript|typescript|csv|yaml|x-yaml)$/.test(entry.type)
		|| /\.(?:txt|md|json|csv|ts|js|vue|css|scss|html|xml|ya?ml)$/i.test(entry.name);
}

function getFileIcon(entry: UploadEntry): Component {
	if (entry.type.startsWith('image/')) return FileImage;
	if (entry.type.startsWith('video/')) return FileVideo;
	if (entry.type.startsWith('audio/')) return FileAudio;
	if (entry.type === 'application/pdf' || isTextLike(entry)) return FileText;
	if (
		/(?:^|\/)(?:json|xml|javascript|typescript|wasm)$/.test(entry.type)
		|| /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|php|py|rb|rs|sh|sql|svelte|swift|ts|tsx|vue|wasm)$/i.test(entry.name)
	) return FileCode;
	if (
		/(?:zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|x-bzip2|zstd)$/.test(entry.type)
		|| /\.(?:7z|bz2|gz|rar|tar|tgz|txz|xz|zip|zst)$/i.test(entry.name)
	) return FileArchive;
	return File;
}

function revokePreviewUrl(): void {
	if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
	previewUrl.value = '';
}

function setFileRowElement(path: string, element: unknown): void {
	if (element instanceof HTMLButtonElement) {
		fileRowElements.value.set(path, element);
	} else {
		fileRowElements.value.delete(path);
	}
}

function selectEntry(entry: UploadEntry | null, focus = false): void {
	selectedEntry.value = entry;
	if (!entry || !focus) return;
	requestAnimationFrame(() => {
		const element = fileRowElements.value.get(entry.path);
		element?.focus();
		element?.scrollIntoView({ block: 'nearest' });
	});
}

function moveSelectedEntry(direction: 1 | -1): void {
	const entries = selectedTree.value?.entries ?? [];
	if (entries.length === 0) return;
	const currentIndex = selectedEntry.value
		? entries.findIndex(entry => entry.path === selectedEntry.value?.path)
		: -1;
	const nextIndex = currentIndex === -1
		? direction === 1 ? 0 : entries.length - 1
		: Math.min(entries.length - 1, Math.max(0, currentIndex + direction));
	selectEntry(entries[nextIndex], true);
}

function onFileListKeydown(event: KeyboardEvent): void {
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		moveSelectedEntry(1);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		moveSelectedEntry(-1);
	}
}

function onItemDragStart(event: DragEvent, item: DraggingUploadItem): void {
	draggingItem.value = item;
	dragOverDirectoryPath.value = null;
	dragPreviewX.value = event.clientX;
	dragPreviewY.value = event.clientY;
	lockMoveCursor();
	event.dataTransfer?.setData('text/plain', item.type === 'file' ? item.entry.path : item.directory.path);
	if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function lockMoveCursor(): void {
	if (document.body.style.cursor === 'grabbing') return;
	previousBodyCursor = document.body.style.cursor;
	document.body.style.cursor = 'grabbing';
}

function resetFileMoveDrag(): void {
	draggingItem.value = null;
	dragOverDirectoryPath.value = null;
	dragPointerId.value = null;
	document.body.style.cursor = previousBodyCursor;
	window.removeEventListener('pointermove', onFileMovePointerMove);
	window.removeEventListener('pointerup', onFileMovePointerUp);
	window.removeEventListener('pointercancel', onFileMovePointerCancel);
}

function onFileDragEnd(): void {
	resetFileMoveDrag();
}

function findDirectoryDropPath(target: EventTarget | null): string | null {
	const element = target instanceof Element
		? target.closest<HTMLElement>('[data-upload-drop-path]')
		: null;
	return element?.dataset.uploadDropPath ?? null;
}

function onFileMovePointerMove(event: PointerEvent): void {
	if (dragPointerId.value !== event.pointerId || !draggingItem.value) return;
	dragPreviewX.value = event.clientX;
	dragPreviewY.value = event.clientY;
	dragOverDirectoryPath.value = findDirectoryDropPath(document.elementFromPoint(event.clientX, event.clientY));
}

async function onFileMovePointerUp(event: PointerEvent): Promise<void> {
	if (dragPointerId.value !== event.pointerId || !draggingItem.value) return;
	const item = draggingItem.value;
	const targetPath = findDirectoryDropPath(document.elementFromPoint(event.clientX, event.clientY));
	resetFileMoveDrag();
	if (targetPath !== null) await moveItemToDirectory(item, targetPath);
}

function onFileMovePointerCancel(event: PointerEvent): void {
	if (dragPointerId.value !== event.pointerId) return;
	resetFileMoveDrag();
}

function onItemMovePointerDown(event: PointerEvent, item: DraggingUploadItem): void {
	if (event.button !== 0) return;
	event.preventDefault();
	draggingItem.value = item;
	dragOverDirectoryPath.value = null;
	dragPointerId.value = event.pointerId;
	dragPreviewX.value = event.clientX;
	dragPreviewY.value = event.clientY;
	lockMoveCursor();
	window.addEventListener('pointermove', onFileMovePointerMove);
	window.addEventListener('pointerup', onFileMovePointerUp);
	window.addEventListener('pointercancel', onFileMovePointerCancel);
}

function onDirectoryDragOver(event: DragEvent, path: string): void {
	if (!draggingItem.value) return;
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
	dragOverDirectoryPath.value = path;
}

function onDirectoryDragLeave(path: string): void {
	if (dragOverDirectoryPath.value === path) dragOverDirectoryPath.value = null;
}

async function onDirectoryDrop(event: DragEvent, path: string): Promise<void> {
	if (!draggingItem.value) return;
	event.preventDefault();
	const item = draggingItem.value;
	resetFileMoveDrag();
	await moveItemToDirectory(item, path);
}

watch(selectedEntry, async (entry) => {
	revokePreviewUrl();
	previewText.value = '';
	previewLoading.value = false;
	if (!entry) return;
	if (
		entry.type.startsWith('image/')
		|| entry.type.startsWith('video/')
		|| entry.type.startsWith('audio/')
		|| entry.type === 'application/pdf'
	) {
		previewUrl.value = URL.createObjectURL(entry.file);
		return;
	}
	if (isTextLike(entry)) {
		previewLoading.value = true;
		try {
			previewText.value = (await readBlobTextPreview(entry.file)).text;
		} finally {
			previewLoading.value = false;
		}
	}
}, { immediate: true });

watch(zipConfirmOpen, (open) => {
	if (open || !zipConfirmResolve) return;
	zipConfirmResolve(false);
	zipConfirmResolve = null;
});

onUnmounted(() => {
	revokePreviewUrl();
	resetFileMoveDrag();
	zipExtractWorker?.terminate();
	zipExtractWorker = null;
});

// ---- OPFS helpers ----

async function streamToOpfs(stream: ReadableStream<Uint8Array<ArrayBuffer>>, name: string): Promise<FileSystemFileHandle> {
	const root = await navigator.storage.getDirectory();
	const handle = await root.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await stream.pipeTo(writable);
	return handle;
}

async function deleteFromOpfs(name: string): Promise<void> {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(name).catch(() => {});
}

// ---- TUS upload (Blob.slice — only CHUNK_SIZE bytes in memory at a time) ----

async function getResumeOffset(fileId: string): Promise<number> {
	const res = await fetch(`/upload/${fileId}/resume`, {
		headers: { 'Tus-Resumable': '1.0.0', ...authHeaders() },
	}).catch(() => null);
	if (!res?.ok) return -1;
	return parseInt(res.headers.get('Upload-Offset') ?? '-1', 10);
}

async function getUploadPartCount(fileId: string): Promise<number> {
	const result = await apiPost('/api/files/create/status', { fileId }).catch(() => null);
	if (!result?.ok) return -1;
	return result.data.partCount;
}

async function tusUpload(fileId: string, blob: Blob, filename: string, partSize: number, onProgress?: (uploaded: number) => void): Promise<boolean> {
	const total = blob.size;
	let offset = Math.max(0, await getResumeOffset(fileId));
	onProgress?.(offset);

	while (offset < total) {
		const chunk = blob.slice(offset, offset + partSize);
		const chunkIndex = offset / partSize; // 0始まりのチャンク番号
		let success = false;

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(`/upload/${fileId}/resume`, {
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/offset+octet-stream',
						'Upload-Offset': String(offset),
						'Content-Length': String(chunk.size),
						'Tus-Resumable': '1.0.0',
						...authHeaders(),
					},
					body: chunk,
				});
				if (res.ok) { success = true; break; }
				if (res.status >= 400 && res.status < 500) {
					const err = (await res.json().catch(() => ({}))) as { message?: string };
					uploadError.value = `アップロード失敗 (${filename}): ${err.message ?? res.status}`;
					return false;
				}
			} catch {
				// ネットワークエラー — コミット済みパーツ数で受信確認
				if (attempt < 2) {
					await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
					const partCount = await getUploadPartCount(fileId);
					if (partCount > chunkIndex) {
						offset = partCount * partSize;
						onProgress?.(offset);
						success = true;
						break;
					}
				}
			}
			if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
		}

		if (!success) {
			uploadError.value = `アップロード失敗 (${filename}): ネットワークエラー（リトライ上限）`;
			return false;
		}

		offset += chunk.size;
		onProgress?.(offset);
	}
	return true;
}

// ---- Core upload primitives ----

async function deleteExistingFile(path: string): Promise<boolean> {
	if (!bucket.value) return false;
	const result = await apiPost('/api/files/delete', { bucketId: bucket.value.id, path });
	return result.ok;
}

interface OpenUploadResult {
	fileId: string;
	partSize: number;
}

async function openUpload(path: string): Promise<OpenUploadResult | null> {
	if (!bucket.value) return null;
	// サーバーのデフォルト (32MiB) を使用するためpartSizeは省略可能
	const result = await apiPost('/api/files/create/open', { bucketId: bucket.value.id, path });
	if (!result.ok) { uploadError.value = result.data.message; return null; }
	return { fileId: result.data.fileId, partSize: result.data.partSize };
}

async function closeUpload(fileId: string): Promise<boolean> {
	const result = await apiPost('/api/files/create/close', {
		fileId,
		visibility: visibility.value,
		isListed: isListed.value,
		passphrase: passphrase.value || undefined,
		isDownloadCountEnabled: isDownloadCountEnabled.value,
		isDownloadCountVisible: isDownloadCountEnabled.value ? isDownloadCountVisible.value : false,
	});
	if (!result.ok) {
		uploadError.value = result.data.message;
		return false;
	}
	return true;
}

/** Upload a Blob (File or OPFS File) via TUS. */
async function uploadBlob(blob: Blob, path: string, onProgress?: (uploaded: number) => void): Promise<boolean> {
	const result = await openUpload(path);
	if (!result) return false;
	const { fileId, partSize } = result;
	if (!(await tusUpload(fileId, blob, path, partSize, onProgress)) || !(await closeUpload(fileId))) {
		await deleteExistingFile(path);
		return false;
	}
	return true;
}

/** Write stream to OPFS, upload as blob, delete temp file. */
async function uploadStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>, path: string, onProgress?: (uploaded: number) => void): Promise<boolean> {
	const tmpName = `__up_${Date.now()}`;
	const handle = await streamToOpfs(stream, tmpName);
	const file = await handle.getFile();
	const ok = await uploadBlob(file, path, onProgress);
	await deleteFromOpfs(tmpName);
	return ok;
}

class TusChunkQueue {
	private fileId: string;
	private path: string;
	private partSize: number;
	private onUploadedBytes?: (total: number) => void;
	private queueChain: Promise<boolean> = Promise.resolve(true);
	private hasError = false;
	private pendingUploads: Promise<boolean>[] = [];

	constructor(fileId: string, path: string, partSize: number, onUploadedBytes?: (total: number) => void) {
		this.fileId = fileId;
		this.path = path;
		this.partSize = partSize;
		this.onUploadedBytes = onUploadedBytes;
	}

	async appendChunk(chunk: Uint8Array<ArrayBuffer>, offset: number, partNum: number, isFinal: boolean): Promise<boolean> {
		const tmpName = `__chunk_${Date.now()}_${partNum}`;
		try {
			const root = await navigator.storage.getDirectory();
			const handle = await root.getFileHandle(tmpName, { create: true });
			const writable = await handle.createWritable();
			await writable.write(chunk);
			await writable.close();

			this.queueUpload({ handle, tmpName, offset, partNum, length: chunk.length, isFinal });
			return true;
		} catch (err) {
			console.error('OPFS チャンク保存失敗', err);
			return false;
		}
	}

	private queueUpload(info: {
		handle: FileSystemFileHandle;
		tmpName: string;
		offset: number;
		partNum: number;
		length: number;
		isFinal: boolean;
	}) {
		const { handle, tmpName, offset, partNum, length, isFinal } = info;
		const promise = this.queueChain.then((prevOk) => {
			if (!prevOk || this.hasError) return false;
			return this.sendChunk(handle, tmpName, offset, partNum, isFinal);
		}).then((ok) => {
			if (!ok) {
				this.hasError = true;
				return false;
			}
			this.onUploadedBytes?.(offset + length);
			return true;
		}).catch(() => {
			this.hasError = true;
			return false;
		});

		this.queueChain = promise.catch(() => false);
		this.pendingUploads.push(promise);
	}

	private async sendChunk(
		handle: FileSystemFileHandle,
		tmpName: string,
		offset: number,
		_partNum: number,
		isFinal: boolean,
	): Promise<boolean> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const file = await handle.getFile();
			const extraHeaders: Record<string, string> = {
				'Content-Length': String(file.size),
			};
			if (isFinal) extraHeaders['Upload-Final'] = '1';

			try {
				const res = await fetch(`/upload/${this.fileId}/resume`, {
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/offset+octet-stream',
						'Upload-Offset': String(offset),
						'Tus-Resumable': '1.0.0',
						...authHeaders(),
						...extraHeaders,
					},
					body: file,
				});

				if (res.ok) {
					const root = await navigator.storage.getDirectory();
					await root.removeEntry(tmpName).catch(() => {});
					return true;
				}

				// 4xx は恒久的エラー
				if (res.status >= 400 && res.status < 500) {
					const root = await navigator.storage.getDirectory();
					await root.removeEntry(tmpName).catch(() => {});
					const err = (await res.json().catch(() => ({}))) as { message?: string };
					uploadError.value = `アップロード失敗 (${this.path}): ${err.message ?? res.status}`;
					return false;
				}
				// 5xx はリトライ
			} catch {
				// ネットワークエラー — コミット済みパーツ数で受信確認
				if (attempt < 2) {
					await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
					const partCount = await getUploadPartCount(this.fileId);
					if (partCount > _partNum) {
						const root = await navigator.storage.getDirectory();
						await root.removeEntry(tmpName).catch(() => {});
						return true;
					}
				}
			}

			if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
		}

		const root = await navigator.storage.getDirectory();
		await root.removeEntry(tmpName).catch(() => {});
		uploadError.value = `アップロード失敗 (${this.path}): ネットワークエラー（リトライ上限）`;
		return false;
	}

	async waitAll(): Promise<boolean> {
		const results = await Promise.all(this.pendingUploads);
		return !this.hasError && results.every((ok) => ok);
	}
}

/** Open upload then stream in partSize pieces via OPFS. Returns fileId or null on error. */
async function uploadChunkedStream(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	path: string,
	onUploadedBytes?: (total: number) => void,
): Promise<string | null> {
	const result = await openUpload(path);
	if (!result) return null;
	const { fileId, partSize } = result;

	const reader = stream.getReader();
	const queue = new TusChunkQueue(fileId, path, partSize, onUploadedBytes);
	let buf = new Uint8Array(0);
	let offset = 0;
	let partNum = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (value) {
				const next = new Uint8Array(buf.length + value.length);
				next.set(buf);
				next.set(value, buf.length);
				buf = next;
			}

			if (buf.length >= partSize) {
				const chunk = buf.slice(0, partSize);
				buf = buf.slice(partSize);
				if (!(await queue.appendChunk(chunk, offset, partNum++, false))) {
					await deleteExistingFile(path);
					return null;
				}
				offset += chunk.length;
			}

			if (done) {
				// 残りのバッファを全て送信（partSize超過でも分割して対応）
				while (buf.length > 0) {
					const isFinal = buf.length <= partSize;
					const chunk = isFinal ? buf : buf.slice(0, partSize);
					buf = buf.slice(chunk.length);
					if (!(await queue.appendChunk(chunk, offset, partNum++, isFinal))) {
						await deleteExistingFile(path);
						return null;
					}
					offset += chunk.length;
				}
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	if (!(await queue.waitAll())) {
		await deleteExistingFile(path);
		return null;
	}

	return fileId;
}

/** Upload tar stream in chunks, then register index. */
async function uploadTarStream(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	index: Promise<TarIndex[]>,
	archivePath: string,
	onUploadedBytes?: (total: number) => void,
): Promise<boolean> {
	const fileId = await uploadChunkedStream(stream, archivePath, onUploadedBytes);
	if (!fileId) return false;

	const resolvedIndex = await index;

	const indexResult = await apiPost('/api/files/create/tar-index', { fileId, files: resolvedIndex });
	if (!indexResult.ok) {
		uploadError.value = indexResult.data.message;
		await deleteExistingFile(archivePath);
		return false;
	}

	if (!(await closeUpload(fileId))) {
		await deleteExistingFile(archivePath);
		return false;
	}
	return true;
}

/** Upload BGZF stream in chunks, then register index. */
async function uploadBgzfStream(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	index: Promise<TarGzIndex[]>,
	archivePath: string,
	onUploadedBytes?: (total: number) => void,
): Promise<boolean> {
	const fileId = await uploadChunkedStream(stream, archivePath, onUploadedBytes);
	if (!fileId) return false;

	const resolvedIndex = await index;

	const bgzfIndexResult = await apiPost('/api/files/create/targz-index', { fileId, files: resolvedIndex });
	if (!bgzfIndexResult.ok) {
		uploadError.value = bgzfIndexResult.data.message;
		await deleteExistingFile(archivePath);
		return false;
	}

	if (!(await closeUpload(fileId))) {
		await deleteExistingFile(archivePath);
		return false;
	}
	return true;
}

// ---- startUpload ----

async function startUpload(): Promise<void> {
	if (isQuotaWarningNeeded.value && !quotaWarningConfirmed.value) {
		quotaWarningOpen.value = true;
		return;
	}
	quotaWarningConfirmed.value = false;
	await executeUpload();
}

async function confirmQuotaWarning(): Promise<void> {
	quotaWarningOpen.value = false;
	quotaWarningConfirmed.value = true;
	await startUpload();
}

async function executeUpload(): Promise<void> {
	uploadError.value = '';
	uploadDone.value = false;
	if (!bucket.value) return;
	const tree = selectedTree.value;
	if (!tree || tree.entries.length === 0) return;

	let files;
	try {
		files = getEffectiveSelectedFileEntries();
	} catch (err) {
		uploadError.value = err instanceof Error ? err.message : String(err);
		return;
	}

	// Pre-upload existence check
	const paths = getUploadPaths(files);
	if (!validateUploadPaths(paths)) return;
	if (paths.length > 0) {
		const conflicts: string[] = [];
		const missingDirectories = new Set<string>();
		for (const { parentPath, targets } of buildUploadConflictDirectoryPlan(paths)) {
			if (isPathUnderMissingDirectory(parentPath, missingDirectories)) continue;
			const result = await apiPost('/api/files/ls', {
				bucketName: selectedBucketName.value,
				path: parentPath,
				limit: 50,
				cursor: null,
			});
			if (result.ok) {
				let entries = result.data.items;
				let cursor = result.data.nextCursor;
				while (cursor) {
					const page = await apiPost('/api/files/ls', {
						bucketName: selectedBucketName.value,
						path: parentPath,
						limit: 50,
						cursor,
					});
					if (!page.ok) break;
					entries = [...entries, ...page.data.items];
					cursor = page.data.nextCursor;
				}
				conflicts.push(...findUploadConflictsInDirectory(targets, entries));
			} else if (result.status === 404) {
				missingDirectories.add(parentPath);
			}
		}
		if (conflicts.length > 0) {
			const msg = `以下のパスにすでにファイルが存在します:\n${conflicts.join('\n')}\n\n上書きしますか？`;
			if (!confirm(msg)) return;
			for (const path of conflicts) {
				if (!(await deleteExistingFile(path))) {
					uploadError.value = `既存ファイルの削除に失敗しました: ${path}`;
					return;
				}
			}
		}
	}

	const jobId = await enqueueUploadJob({
		bucketId: bucket.value.id,
		bucketName: selectedBucketName.value,
		prefix: uploadPrefix.value,
		mode: archiveMode.value,
		archiveBaseName: archiveUploadBaseName.value,
		visibility: visibility.value,
		isListed: isListed.value,
		passphrase: passphrase.value || undefined,
		isDownloadCountEnabled: isDownloadCountEnabled.value,
		isDownloadCountVisible: isDownloadCountEnabled.value ? isDownloadCountVisible.value : false,
		imageCompression: {
			enabled: compressImagesOnUpload.value && archiveMode.value === 'individual',
			quality: imageCompressionQuality.value,
			maxWidth: imageCompressionMaxWidth.value,
			maxHeight: imageCompressionMaxHeight.value,
			mimeType: imageCompressionMimeType.value,
		},
		partSize: browserUploadPartSizeBytes.value,
		nonResumeUploadLimitBytes: browserUploadNonResumeLimitBytes.value,
		files,
		totalBytes: tree.totalSize,
		authToken: authStore.token,
	});
	redirectUploadJobId.value = jobId;
	uploadDone.value = true;
}

onMounted(async () => {
	canEncodeWebp.value = await detectWebpEncodingSupport();
	if (!canEncodeWebp.value && imageCompressionMimeType.value === 'image/webp') {
		imageCompressionMimeType.value = 'image/jpeg';
	}
	await loadBucket();
	const pending = takePendingUpload();
	if (pending) {
		if (pending.bucketName) selectedBucketName.value = pending.bucketName;
		if (pending.tree.entries.length > 0) await addSelectedTreeWithZipPrompts(await UploadTree.from(pending.tree));
		uploadPrefix.value = pending.prefix;
	}
	await consumeShareTargetPayload();
});
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">アップロード</h2>
    </div>

    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>
    <div v-else-if="loadError" class="alert alert-error">{{ loadError }}</div>
    <template v-else>
      <div :class="$style.uploadStack">
        <!-- アップロード先選択 -->
        <div :class="['card']">
          <p class="card-title">アップロード先</p>
          <div :class="$style.destinationRow">
            <template v-if="selectedBucketName">
              <span :class="[$style.destinationDisplay, 'font-mono']">{{ selectedBucketName }}/{{ uploadPrefix }}</span>
              <Button.Root class="btn btn-secondary" @click="destinationDialogOpen = true">
                <Button.Content>変更</Button.Content>
              </Button.Root>
            </template>
            <template v-else>
              <Button.Root class="btn btn-primary" @click="destinationDialogOpen = true">
                <Button.Content>アップロード先を選択</Button.Content>
              </Button.Root>
            </template>
          </div>
          <UploadDestinationDialog
            v-model:open="destinationDialogOpen"
            :initial-bucket-name="selectedBucketName"
            :initial-prefix="uploadPrefix"
            @select="({ bucketName, prefix }) => { selectedBucketName = bucketName; uploadPrefix = prefix; }"
          />
        </div>

        <!-- ファイル選択 -->
        <div
          :class="['card', $style.dropSection, { [$style.dropSectionActive]: isDragOver }]"
          @dragenter.prevent="isDragOver = true"
          @dragover.prevent="isDragOver = true"
          @dragleave.prevent="isDragOver = false"
          @drop.prevent="handleDrop"
        >
          <p :class="['card-title', $style.fileSelectCardTitle]">
            ファイル選択
            <span v-if="selectedTree" class="badge badge-info">
              {{ selectedTree.entries.length }} ファイル / {{ formatBytes(selectedTree.totalSize) }}
            </span>
          </p>
          <p :class="[$style.dropHint]">ここにファイルやフォルダをドラッグ＆ドロップで追加</p>

          <div class="flex items-center gap-2 flex-wrap mt-2">
            <label :class="[$style.fileLabel, 'btn', 'btn-primary']">
              ファイルを選択
              <input
                type="file"
                multiple
                :class="$style.hiddenInput"
                @change="handleFileInputChange"
              >
            </label>

            <label :class="[$style.fileLabel, 'btn', 'btn-primary']">
              フォルダを選択
              <input
                type="file"
                webkitdirectory
                multiple
                :class="$style.hiddenInput"
                @change="handleFileInputChange"
              >
            </label>

            <Button.Root
              v-if="selectedTree"
              class="btn btn-secondary"
              @click="clearSelectedTree"
            >
              <Button.Content>初期化</Button.Content>
            </Button.Root>

          </div>
          <div v-if="selectionError" class="alert alert-error mt-3">{{ selectionError }}</div>
          <div v-if="zipWarnings.length > 0" class="alert alert-info mt-3">
            <div v-for="warning in zipWarnings" :key="warning">{{ warning }}</div>
          </div>

        <div v-if="hasSelection" class="mt-3">
          <div :class="$style.fileBrowser">
            <div :class="$style.previewPane">
              <template v-if="!selectedEntry">
                <p :class="$style.previewEmpty">ファイルを選択</p>
              </template>
              <template v-else-if="previewKind === 'image'">
                <img :src="previewUrl" :alt="selectedEntry.name" :class="$style.previewImage">
              </template>
              <template v-else-if="previewKind === 'video'">
                <video :src="previewUrl" :class="$style.previewVideo" controls preload="metadata" />
              </template>
              <template v-else-if="previewKind === 'audio'">
                <div :class="$style.previewAudioWrap">
                  <span :class="$style.previewName">{{ selectedEntry.name }}</span>
                  <audio :src="previewUrl" :class="$style.previewAudio" controls preload="metadata" />
                </div>
              </template>
              <template v-else-if="previewKind === 'pdf'">
                <object :data="previewUrl" type="application/pdf" :class="$style.previewObject">
                  <p :class="$style.previewEmpty">{{ selectedEntry.name }}</p>
                </object>
              </template>
              <template v-else-if="previewKind === 'text'">
                <pre :class="$style.previewText">{{ previewLoading ? '読み込み中...' : previewText }}</pre>
              </template>
              <template v-else>
                <div :class="$style.previewMeta">
                  <span :class="$style.previewName">{{ selectedEntry.name }}</span><br>
                  <span>{{ selectedEntry.path }}</span><br>
                  <span>{{ selectedEntry.type || 'application/octet-stream' }}</span><br>
                  <span>{{ formatBytes(selectedEntry.size) }}</span>
                </div>
              </template>
            </div>
            <div :class="[$style.fileListPane, draggingItem ? $style.fileListPaneDragging : '']" @keydown="onFileListKeydown">
              <div
                v-for="item in draggingItem ? directoryDropEntries : flatDisplayEntries"
                :key="item.key"
                :class="[
                  $style.fileRow,
                  item.type === 'dir' || item.type === 'root' ? $style.dirRow : $style.fileItemRow,
                  item.type === 'root' ? $style.rootDropRow : '',
                  item.type !== 'file' && dragOverDirectoryPath === item.path ? $style.dirRowDragOver : '',
                  item.type !== 'file' && draggingSourceDirectoryPath === item.path ? $style.dirRowDragSource : '',
                  item.type === 'file' && selectedEntry?.path === item.entry.path ? $style.fileRowSelected : '',
                ]"
                :style="{ paddingLeft: `${6 + item.depth * 18}px` }"
                :data-upload-drop-path="item.type !== 'file' ? item.path : undefined"
                @dragover="item.type !== 'file' ? onDirectoryDragOver($event, item.path) : undefined"
                @dragleave="item.type !== 'file' ? onDirectoryDragLeave(item.path) : undefined"
                @drop="item.type !== 'file' ? onDirectoryDrop($event, item.path) : undefined"
              >
                <button
                  v-if="item.type === 'file' || (item.type === 'dir' && !draggingItem)"
                  type="button"
                  :class="$style.fileDragHandle"
                  draggable="true"
                  :aria-label="item.type === 'file' ? 'ファイルを移動' : 'ディレクトリを移動'"
                  @dragstart="onItemDragStart($event, item.type === 'file' ? { type: 'file', entry: item.entry } : { type: 'dir', directory: item })"
                  @dragend="onFileDragEnd"
                  @pointerdown="onItemMovePointerDown($event, item.type === 'file' ? { type: 'file', entry: item.entry } : { type: 'dir', directory: item })"
                  @click.stop
                >
                  <GripVertical :size="16" :stroke-width="2" aria-hidden="true" />
                </button>
                <button
                  v-if="item.type === 'file'"
                  :ref="element => setFileRowElement(item.entry.path, element)"
                  type="button"
                  :class="$style.fileSelectButton"
                  @click="selectEntry(item.entry)"
                >
                  <component :is="getFileIcon(item.entry)" :class="$style.fileIcon" :size="16" :stroke-width="2" aria-hidden="true" />
                  <span :class="$style.fileName">{{ item.entry.name }}</span>
                  <span :class="$style.fileSize">{{ formatBytes(item.entry.size) }}</span>
                </button>
                <template v-else>
                  <FolderOpen v-if="item.type === 'root'" :class="$style.fileIcon" :size="16" :stroke-width="2" aria-hidden="true" />
                  <Folder v-else :class="$style.fileIcon" :size="16" :stroke-width="2" aria-hidden="true" />
                  <span :class="$style.fileName">{{ item.name }}</span>
                </template>
                <Popover.Root v-if="item.type === 'file'">
                  <Popover.Activator
                    :class="['btn', 'btn-ghost', 'btn-icon', $style.fileMenuButton]"
                    aria-label="ファイル操作メニュー"
                    @click.stop
	                  >
	                    <EllipsisVertical :size="16" :stroke-width="2" />
	                  </Popover.Activator>
                  <Popover.Content class="action-menu">
                    <div class="action-menu-inner">
                      <Button.Root class="btn btn-ghost-danger w-full" @click="removeSelectedEntry(item.entry.path)">
                        <Button.Content>削除</Button.Content>
                      </Button.Root>
                    </div>
                  </Popover.Content>
                </Popover.Root>
              </div>
              <div
                v-if="draggingItem"
                :class="$style.fileMovePreview"
                :style="{ transform: `translate(${dragPreviewX + 12}px, ${dragPreviewY + 12}px)` }"
              >
                <span :class="$style.fileMovePreviewName">{{ draggingItemName }}</span>
                <span>ここに移動</span>
              </div>
            </div>
          </div>

          <p class="form-label" :class="$style.archiveModeLabel">アップロード形式</p>
          <div :class="$style.archiveModeList">
            <label :class="[$style.archiveModeOption, archiveMode === 'individual' ? $style.archiveModeOptionSelected : null]">
              <input :checked="archiveMode === 'individual'" type="radio" value="individual" :class="$style.radioInput" @change="updateArchiveMode('individual')">
              <File :class="$style.archiveModeIcon" :size="20" :stroke-width="2" aria-hidden="true" />
              <span :class="$style.archiveModeBody">
                <span :class="$style.archiveModeText">個別ファイルとしてアップロード</span>
                <span :class="$style.archiveModeDescription">各ファイルごとにアップロード数を消費</span>
              </span>
            </label>
            <label :class="[$style.archiveModeOption, archiveMode === 'gz' ? $style.archiveModeOptionSelected : null]">
              <input :checked="archiveMode === 'gz'" type="radio" value="gz" :class="$style.radioInput" @change="updateArchiveMode('gz')">
              <FileArchive :class="$style.archiveModeIcon" :size="20" :stroke-width="2" aria-hidden="true" />
              <span :class="$style.archiveModeBody">
                <span :class="$style.archiveModeText">gzip 圧縮してアップロード</span>
                <span :class="$style.archiveModeDescription">各ファイルを .gz として保存</span>
              </span>
              <span class="badge badge-muted" :class="$style.archiveModeBadge">.gz</span>
            </label>
            <label :class="[$style.archiveModeOption, archiveMode === 'tar' ? $style.archiveModeOptionSelected : null]">
              <input :checked="archiveMode === 'tar'" type="radio" value="tar" :class="$style.radioInput" @change="updateArchiveMode('tar')">
              <FileArchive :class="$style.archiveModeIcon" :size="20" :stroke-width="2" aria-hidden="true" />
              <span :class="$style.archiveModeBody">
                <span :class="$style.archiveModeText">tar にまとめてアップロード</span>
                <span :class="$style.archiveModeDescription">無圧縮のアーカイブとして保存</span>
              </span>
              <span :class="['badge', shouldRecommendTarForCompressedImages ? 'badge-info' : 'badge-muted', $style.archiveModeBadge]">
                {{ shouldRecommendTarForCompressedImages ? 'おすすめ' : '無圧縮' }}
              </span>
            </label>
            <label :class="[$style.archiveModeOption, archiveMode === 'targz' ? $style.archiveModeOptionSelected : null]">
              <input :checked="archiveMode === 'targz'" type="radio" value="targz" :class="$style.radioInput" @change="updateArchiveMode('targz')">
              <FileArchive :class="$style.archiveModeIcon" :size="20" :stroke-width="2" aria-hidden="true" />
              <span :class="$style.archiveModeBody">
                <span :class="$style.archiveModeText">tar.gz にまとめてアップロード</span>
                <span :class="$style.archiveModeDescription">BGZF圧縮 グリッドビューでのプレビュー非対応</span>
              </span>
              <span class="badge badge-info" :class="$style.archiveModeBadge">ランダムアクセス対応</span>
            </label>
          </div>
          <div v-if="shouldRecommendTarForCompressedImages" class="alert alert-info mt-3" :class="$style.tarRecommendation">
            {{ tarRecommendationMessage }}
          </div>
          <div v-if="archiveMode === 'tar' || archiveMode === 'targz'" :class="[$style.libraryNameGroup, 'form-group']">
            <label class="form-label" for="upload-library-name">ライブラリ名</label>
            <input
              id="upload-library-name"
              v-model="libraryName"
              class="form-input form-input-mono"
              type="text"
              :placeholder="archiveBaseName"
            >
            <div class="form-hint">
              {{ archiveUploadBaseName }}{{ archiveMode === 'tar' ? '.tar' : '.tar.gz' }}
            </div>
          </div>
        </div>
      </div>

        <!-- オプション -->
        <div class="card">
          <p class="card-title">オプション</p>
          <div :class="$style.optionSection">
            <div :class="$style.imageCompressionHeader">
              <label :class="['checkbox-label', archiveMode !== 'individual' ? $style.optionDisabled : null]">
                <input
                  v-model="compressImagesOnUpload"
                  type="checkbox"
                  :disabled="archiveMode !== 'individual'"
                >
                <span>画像を圧縮してアップロード</span>
              </label>
              <Button.Root
                class="btn btn-secondary"
                :disabled="archiveMode !== 'individual'"
                @click="imageCompressionDialogOpen = true"
              >
                <Button.Content>圧縮設定</Button.Content>
              </Button.Root>
            </div>
            <p :class="$style.optionHint">
              個別アップロード時のみ、画像をJPEGへ変換してからアップロードします。EXIFなどのメタデータは引き継がれません。
            </p>
            <p :class="$style.optionSummary">
              {{ imageCompressionMimeType === 'image/webp' ? 'WebP' : 'JPEG' }} / 品質 {{ imageCompressionQuality }} / 最大 {{ imageCompressionMaxWidth }} x {{ imageCompressionMaxHeight }}
            </p>
          </div>
          <FileVisibilitySettings
            v-model:visibility="visibility"
            v-model:isListed="isListed"
            v-model:passphrase="passphrase"
            v-model:isDownloadCountEnabled="isDownloadCountEnabled"
            v-model:isDownloadCountVisible="isDownloadCountVisible"
            :can-use-download-count="canUseDownloadCount"
            :show-download-count-settings="true"
            passphrase-autocomplete="off"
          />
        </div>

        <!-- 開始ボタン -->
        <div>
          <Button.Root
            class="btn btn-primary btn-lg w-full"
            :class="$style.fullButton"
            :disabled="!selectedTree || selectedTree.entries.length === 0 || uploadDone && !uploadError"
            @click="startUpload"
          >
            <Button.Content>アップロード開始</Button.Content>
          </Button.Root>
        </div>

        <div v-if="uploadError" class="alert alert-error">{{ uploadError }}</div>
        <div v-if="uploadDone" class="alert alert-success">
          アップロードジョブを開始しました。
          <NirA to="/my/uploadings?tab=browser" :class="$style.doneLink">進捗を見る →</NirA>
        </div>
      </div>

      <ConfirmDialog
        v-model:open="quotaWarningOpen"
        title="クォータを超える可能性があります"
        :message="quotaWarningMessage"
        confirm-label="続行"
        cancel-label="キャンセル"
        danger
        @confirm="confirmQuotaWarning"
        @cancel="quotaWarningOpen = false"
      />

      <ConfirmDialog
        v-model:open="zipConfirmOpen"
        title="ZIPを展開しますか？"
        :message="`${zipConfirmFileName} を展開して中身をアップロード対象に追加します。キャンセルするとZIPファイルのまま追加します。`"
        confirm-label="展開する"
        cancel-label="ZIPのまま追加"
        @confirm="resolveZipConfirm(true)"
        @cancel="resolveZipConfirm(false)"
      />

      <Dialog.Root :model-value="zipPasswordOpen" @update:model-value="value => { if (!value) cancelZipPassword(); }">
        <Dialog.Content :class="$style.dialog">
          <form :class="$style.dialogInner" @submit.prevent="submitZipPassword">
            <div :class="$style.dialogHeader">
              <Dialog.Title :class="$style.dialogTitle">ZIPパスワード</Dialog.Title>
              <Dialog.Close class="btn btn-ghost btn-icon" aria-label="閉じる" @click="cancelZipPassword">✕</Dialog.Close>
            </div>
            <p :class="$style.dialogDescription">{{ zipPasswordFileName }} はパスワードで保護されています。</p>
            <label class="form-label" for="zip-password">パスワード</label>
            <input
              id="zip-password"
              v-model="zipPassword"
              class="form-input"
              type="password"
              autocomplete="current-password"
            >
            <p v-if="zipPasswordError" :class="$style.dialogError">{{ zipPasswordError }}</p>
            <div :class="$style.dialogActions">
              <button type="button" class="btn btn-secondary" @click="cancelZipPassword">ZIPのまま追加</button>
              <button type="submit" class="btn btn-primary">展開する</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root :model-value="zipExtractingOpen">
        <Dialog.Content :class="$style.dialog">
          <div :class="$style.dialogInner">
            <Dialog.Title :class="$style.dialogTitle">ZIPを展開中</Dialog.Title>
            <p :class="$style.dialogDescription">{{ zipExtractingFileName }}</p>
            <div class="progress-root" aria-hidden="true">
              <div class="progress-track">
                <div
                  class="progress-fill"
                  :style="{ '--v0-progress-fill': zipExtractingTotalFiles > 0 ? `${Math.round(zipExtractingFileIndex / zipExtractingTotalFiles * 100)}%` : '0%' }"
                />
              </div>
            </div>
            <p :class="$style.dialogDescription">
              {{ zipExtractingFileIndex }} / {{ zipExtractingTotalFiles || '?' }}
              <span v-if="zipExtractingCurrentFileName">: {{ zipExtractingCurrentFileName }}</span>
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root :model-value="imageCompressionDialogOpen" @update:model-value="imageCompressionDialogOpen = $event">
        <Dialog.Content :class="$style.dialog">
          <div :class="$style.dialogInner">
            <div :class="$style.dialogHeader">
              <Dialog.Title :class="$style.dialogTitle">画像圧縮設定</Dialog.Title>
              <Dialog.Close class="btn btn-ghost btn-icon" aria-label="閉じる">✕</Dialog.Close>
            </div>
            <p :class="$style.dialogDescription">
              アップロード前に画像を変換します。WebP非対応ブラウザではJPEGへフォールバックします。EXIFなどのメタデータは引き継がれません。
            </p>
            <label class="form-group">
              <span class="form-label">出力形式</span>
              <select v-model="imageCompressionMimeType" class="form-input">
                <option value="image/webp" :disabled="!canEncodeWebp">WebP</option>
                <option value="image/jpeg">JPEG</option>
              </select>
            </label>
            <p v-if="!canEncodeWebp" :class="$style.dialogDescription">
              このブラウザではWebP出力を利用できないため、JPEGでアップロードします。
            </p>
            <label class="form-group">
              <span class="form-label">品質</span>
              <input
                v-model.number="imageCompressionQuality"
                class="form-input"
                type="number"
                min="0.1"
                max="1"
                step="0.05"
              >
            </label>
            <label class="form-group">
              <span class="form-label">最大幅</span>
              <input
                v-model.number="imageCompressionMaxWidth"
                class="form-input"
                type="number"
                min="1"
                step="1"
              >
            </label>
            <label class="form-group">
              <span class="form-label">最大高さ</span>
              <input
                v-model.number="imageCompressionMaxHeight"
                class="form-input"
                type="number"
                min="1"
                step="1"
              >
            </label>
            <div :class="$style.dialogActions">
              <Button.Root class="btn btn-primary" @click="imageCompressionDialogOpen = false">
                <Button.Content>閉じる</Button.Content>
              </Button.Root>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Root>
    </template>
  </div>
</template>

<style module lang="scss">
.dialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  width: min(460px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.dialogInner {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dialogHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dialogTitle {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
}

.dialogDescription {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  margin: 0;
  word-break: break-word;
}

.dialogError {
  color: var(--color-danger);
  font-size: 0.8125rem;
  margin: 0;
}

.dialogActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.uploadStack {
  display: grid;
  gap: 16px;
}

.destinationRow {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.destinationDisplay {
  font-size: 0.9rem;
  background: var(--color-surface);
  border-radius: var(--radius);
  padding: 6px 10px;
  word-break: break-all;
}

.fileLabel {
  cursor: pointer;
}

.hiddenInput {
  display: none;
}

.dropSection {
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}

.dropSectionActive {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.filePickerBar {
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
  padding: 14px;
  background: var(--color-bg);
}

.fileSelectCardTitle {
  margin-bottom: 4px;
}

.dropHint {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.optionSection {
  display: grid;
  gap: 10px;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--color-border);
}

.optionDisabled {
  opacity: 0.58;
}

.imageCompressionHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.optionHint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.optionSummary {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}

.fileBrowser {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(260px, 1.2fr);
  gap: 12px;
  margin-bottom: 16px;
}

.previewPane,
.fileListPane {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  min-height: 260px;
  overflow: auto;
}

.previewPane {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  height: 360px;
}

.fileListPane {
  min-height: 100px;
  max-height: 360px
}

.previewImage {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.previewVideo {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.previewAudioWrap {
  width: min(100%, 420px);
  padding: 16px;
  text-align: center;
}

.previewAudio {
  width: 100%;
  margin-top: 12px;
}

.previewObject {
  width: 100%;
  height: 100%;
  border: 0;
}

.previewText {
  width: 100%;
  height: 100%;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8125rem;
  line-height: 1.45;
}

.previewEmpty,
.previewMeta {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  padding: 16px;
  text-align: center;
}

.previewMeta {
  width: 100%;
  word-break: break-all;
}

.previewName {
  color: var(--color-text);
  font-weight: 600;
}

.fileListPane {
  padding: 0;
}

.fileListPaneDragging,
.fileListPaneDragging * {
  cursor: grabbing;
}

.fileRow {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  color: var(--color-text);
  font: inherit;
  padding: 7px 6px;
  border-left: 3px solid transparent;
}

.fileItemRow {
  padding-top: 2px;
  padding-bottom: 2px;
}

.fileItemRow:hover {
  background: var(--color-surface);
}

.fileRowSelected {
  background: var(--color-primary-surface, color-mix(in srgb, var(--color-primary) 12%, transparent));
  border-left-color: var(--color-primary);
}

.fileRowSelected .fileSelectButton {
  color: var(--color-primary);
  font-weight: 600;
}

.dirRow {
  grid-template-columns: auto auto minmax(0, 1fr);
  color: var(--color-text-muted);
  font-weight: 600;
}

.fileListPaneDragging .dirRow {
  grid-template-columns: auto minmax(0, 1fr);
}

.rootDropRow {
  grid-template-columns: auto minmax(0, 1fr);
  color: var(--color-text);
}

.dirRowDragOver {
  background: var(--color-primary-surface, color-mix(in srgb, var(--color-primary) 12%, transparent));
  border-left-color: transparent;
  color: var(--color-primary);
}

.dirRowDragSource {
  border-left-color: var(--color-primary);
}

.dirRowDragSource.dirRowDragOver {
  border-left-color: var(--color-primary);
}

.fileDragHandle {
  width: 24px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-muted);
  cursor: grab;
}

.fileDragHandle:hover,
.fileDragHandle:focus-visible {
  background: var(--color-surface);
  color: var(--color-text);
}

.fileDragHandle:active {
  cursor: grabbing;
}

.fileMovePreview {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 50;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(320px, calc(100vw - 32px));
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  box-shadow: var(--shadow);
  font-size: 0.8125rem;
  font-weight: 600;
  pointer-events: none;
}

.fileMovePreviewName {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-primary);
}

.fileSelectButton {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 5px 0;
  cursor: pointer;
}

.fileMenuButton {
  align-self: center;
}

.fileIcon {
  color: var(--color-text-muted);
  flex: 0 0 auto;
}

.fileName {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fileSize {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.archiveModeLabel {
  margin-bottom: 8px;
}

.archiveModeList {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.archiveModeOption {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  min-height: 78px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
}

.archiveModeOption:hover {
  border-color: var(--color-border-focus);
  background: var(--color-surface);
}

.archiveModeOptionSelected {
  border-color: var(--color-primary);
  background: var(--color-primary-surface, color-mix(in srgb, var(--color-primary) 10%, transparent));
  box-shadow: inset 0 0 0 1px var(--color-primary);
}

.archiveModeIcon {
  margin-top: 2px;
  color: var(--color-text-muted);
}

.archiveModeOptionSelected .archiveModeIcon {
  color: var(--color-primary);
}

.archiveModeBody {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.archiveModeText {
  min-width: 0;
  color: var(--color-text);
  font-weight: 600;
  line-height: 1.35;
}

.archiveModeDescription {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.4;
}

.archiveModeBadge {
  justify-self: end;
  white-space: nowrap;
}

.libraryNameGroup {
  margin-top: 14px;
  max-width: 360px;
}

.radioInput {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.archiveModeOption:has(.radioInput:focus-visible) {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.doneLink {
  margin-left: 8px;
  font-weight: 600;
}

.fullButton {
  justify-content: center;
}

@media (max-width: 720px) {
  .fileBrowser {
    grid-template-columns: 1fr;
  }

  .archiveModeOption {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .archiveModeBadge {
    grid-column: 2;
    justify-self: start;
  }
}

@media (max-width: 860px) {
  .archiveModeList {
    grid-template-columns: 1fr;
  }
}
</style>
