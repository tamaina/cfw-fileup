<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import type { FileVisibility } from '../../shared/file-visibility';
import { Button, Progress } from '@vuetify/v0';
import { authHeaders, authStore } from '../store/auth';
import { apiPost } from '../utils/api';
import NirA from '@/components/nira.vue';
import { TarArchiver, BgzfTarArchiver, type TarIndex, type TarGzIndex, type ArchiveProgress } from 'bgzf';
import { takePendingUpload } from '@/store/pending-upload';
import UploadDestinationDialog from '@/components/upload-destination-dialog.vue';

type ArchiveMode = 'individual' | 'gz' | 'tar' | 'targz';

interface Bucket {
	id: string;
	name: string;
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
const loadError = ref('');

const selectedFiles = ref<File[]>([]);
const uploadPrefix = ref('');
const selectedDir = ref<FileSystemDirectoryHandle | null>(null);
const selectedDirName = ref('');
const archiveMode = ref<ArchiveMode>('individual');
const visibility = ref<FileVisibility>('public');
const passphrase = ref('');
interface UploadProgress {
	filename: string;
	fileIndex: number;
	totalFiles: number;
	uploadedBytes: number;
	totalBytes: number;
}

const uploadProgress = ref<UploadProgress | null>(null);
const uploadError = ref('');
const uploadDone = ref(false);

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function getUploadPaths(): string[] {
	if (selectedDir.value) {
		if (archiveMode.value === 'tar') return [`${selectedDirName.value}.tar`];
		if (archiveMode.value === 'targz') return [`${selectedDirName.value}.tar.gz`];
		return [];
	}
	if (!selectedFiles.value.length) return [];
	return selectedFiles.value.map(f =>
		archiveMode.value === 'gz'
			? `${uploadPrefix.value}${f.name}.gz`
			: `${uploadPrefix.value}${f.name}`,
	);
}

const supportsFileAccessAPI = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

async function loadBucket(): Promise<void> {
	const result = await apiPost('/api/buckets/list');
	if (!result.ok) {
		loadError.value = result.data.error;
		return;
	}
	buckets.value = result.data.buckets;
	if (!selectedBucketName.value && buckets.value.length > 0) {
		selectedBucketName.value = buckets.value[0].name;
	}
}

async function pickDirectory(): Promise<void> {
	if (!('showDirectoryPicker' in window)) {
    alert('folder picker is not supported!');
    return;
  }
	try {
		const handle = await (window as unknown as any).showDirectoryPicker();
		selectedDir.value = handle;
		selectedDirName.value = handle.name;
		selectedFiles.value = [];
	} catch (e) {
		console.error('showDirectoryPicker failed', e)
	}
}

// ---- OPFS helpers ----

async function streamToOpfs(stream: ReadableStream<Uint8Array>, name: string): Promise<FileSystemFileHandle> {
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
					const err = (await res.json().catch(() => ({}))) as { error?: string };
					uploadError.value = `アップロード失敗 (${filename}): ${err.error ?? res.status}`;
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
	if (!result.ok) { uploadError.value = result.data.error; return null; }
	return { fileId: result.data.fileId, partSize: result.data.partSize };
}

async function closeUpload(fileId: string): Promise<boolean> {
	const result = await apiPost('/api/files/create/close', { fileId, visibility: visibility.value, passphrase: passphrase.value || undefined });
	if (!result.ok) {
		uploadError.value = result.data.error;
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
async function uploadStream(stream: ReadableStream<Uint8Array>, path: string, onProgress?: (uploaded: number) => void): Promise<boolean> {
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
					const err = (await res.json().catch(() => ({}))) as { error?: string };
					uploadError.value = `アップロード失敗 (${this.path}): ${err.error ?? res.status}`;
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
	stream: ReadableStream<Uint8Array>,
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
	stream: ReadableStream<Uint8Array>,
	index: Promise<TarIndex[]>,
	archivePath: string,
	onUploadedBytes?: (total: number) => void,
): Promise<boolean> {
	const fileId = await uploadChunkedStream(stream, archivePath, onUploadedBytes);
	if (!fileId) return false;

	const resolvedIndex = await index;

	const indexResult = await apiPost('/api/files/create/tar-index', { fileId, files: resolvedIndex });
	if (!indexResult.ok) {
		uploadError.value = indexResult.data.error;
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
	stream: ReadableStream<Uint8Array>,
	index: Promise<TarGzIndex[]>,
	archivePath: string,
	onUploadedBytes?: (total: number) => void,
): Promise<boolean> {
	const fileId = await uploadChunkedStream(stream, archivePath, onUploadedBytes);
	if (!fileId) return false;

	const resolvedIndex = await index;

	const bgzfIndexResult = await apiPost('/api/files/create/targz-index', { fileId, files: resolvedIndex });
	if (!bgzfIndexResult.ok) {
		uploadError.value = bgzfIndexResult.data.error;
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
	uploadError.value = '';
	uploadDone.value = false;
	uploadProgress.value = null;
	if (!bucket.value) return;

	// Pre-upload existence check
	const paths = getUploadPaths();
	if (paths.length > 0) {
		const conflicts: string[] = [];
		for (const path of paths) {
			const lastSlash = path.lastIndexOf('/');
			const parentPath = lastSlash === -1 ? '' : path.slice(0, lastSlash + 1);
			const fileName = path.slice(lastSlash + 1);
			const result = await apiPost('/api/files/ls', {
				bucketName: selectedBucketName.value,
				path: parentPath,
			});
			if (result.ok) {
				if (result.data.entries.some(e => e.type === 'file' && e.name === fileName)) {
					conflicts.push(path);
				}
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

	// Directory (File System Access API)
	if (selectedDir.value) {
		if (archiveMode.value === 'individual') {
			const allEntries: Array<{ path: string; file: File }> = [];
			for await (const entry of TarArchiver.walkDirectory(selectedDir.value)) allEntries.push(entry);
			const totalFiles = allEntries.length;
			const totalBytes = allEntries.reduce((s, e) => s + e.file.size, 0);
			let cumulativeBytes = 0;
			for (let i = 0; i < allEntries.length; i++) {
				const { path, file } = allEntries[i];
				uploadProgress.value = { filename: path, fileIndex: i + 1, totalFiles, uploadedBytes: cumulativeBytes, totalBytes };
				if (!(await uploadBlob(file, path, (n) => {
					uploadProgress.value = { filename: path, fileIndex: i + 1, totalFiles, uploadedBytes: cumulativeBytes + n, totalBytes };
				}))) return;
				cumulativeBytes += file.size;
			}
		} else if (archiveMode.value === 'tar') {
			uploadProgress.value = { filename: '', fileIndex: 0, totalFiles: 0, uploadedBytes: 0, totalBytes: 0 };
			const archiver = await TarArchiver.create(selectedDir.value, (p: ArchiveProgress) => {
				if (!uploadProgress.value) return;
        console.info('tar create', p);
				uploadProgress.value = { ...uploadProgress.value, filename: p.currentFile, fileIndex: p.processedFiles + 1, totalFiles: p.totalFiles };
			});
			if (!(await uploadTarStream(archiver.stream, archiver.index, `${selectedDirName.value}.tar`, (n) => {
				if (uploadProgress.value) {
          uploadProgress.value = { ...uploadProgress.value, uploadedBytes: n };
        }
			}))) return;
		} else {
			uploadProgress.value = { filename: '', fileIndex: 0, totalFiles: 0, uploadedBytes: 0, totalBytes: 0 };
			const archiver = await BgzfTarArchiver.create(selectedDir.value, (p: ArchiveProgress) => {
				if (!uploadProgress.value) return;
				uploadProgress.value = { ...uploadProgress.value, filename: p.currentFile, fileIndex: p.processedFiles + 1, totalFiles: p.totalFiles };
			});
			if (!(await uploadBgzfStream(archiver.stream, archiver.index, `${selectedDirName.value}.tar.gz`, (n) => {
				if (uploadProgress.value) uploadProgress.value = { ...uploadProgress.value, uploadedBytes: n };
			}))) return;
		}
		uploadDone.value = true;
		return;
	}

	// Regular file(s) — tar/bgzf modes are directory-only
	if (selectedFiles.value && selectedFiles.value.length > 0) {
		const fileArr = Array.from(selectedFiles.value);
		const totalFiles = fileArr.length;
		const isGz = archiveMode.value === 'gz';
		const totalBytes = isGz ? 0 : fileArr.reduce((s, f) => s + f.size, 0);
		let cumulativeBytes = 0;

		for (let i = 0; i < fileArr.length; i++) {
			const file = fileArr[i];
			uploadProgress.value = { filename: file.name, fileIndex: i + 1, totalFiles, uploadedBytes: cumulativeBytes, totalBytes };
			if (isGz) {
				const stream = file.stream().pipeThrough(new CompressionStream('gzip'));
				if (!(await uploadStream(stream, `${uploadPrefix.value}${file.name}.gz`, (n) => {
					if (uploadProgress.value) uploadProgress.value = { ...uploadProgress.value, uploadedBytes: cumulativeBytes + n };
				}))) return;
				cumulativeBytes += file.size;
			} else {
				if (!(await uploadBlob(file, `${uploadPrefix.value}${file.name}`, (n) => {
					if (uploadProgress.value) uploadProgress.value = { ...uploadProgress.value, uploadedBytes: cumulativeBytes + n };
				}))) return;
				cumulativeBytes += file.size;
			}
		}
		uploadDone.value = true;
	}
}

onMounted(async () => {
	await loadBucket();
	const pending = takePendingUpload();
	if (pending) {
		if (pending.bucketName) selectedBucketName.value = pending.bucketName;
		selectedFiles.value = pending.files;
		uploadPrefix.value = pending.prefix;
	}
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
      <!-- アップロード先選択 -->
      <div class="upload-section">
        <p class="upload-section-title">アップロード先</p>
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
          @select="({ bucketName, prefix }) => { selectedBucketName = bucketName; uploadPrefix = prefix; }"
        />
      </div>

      <!-- ファイル選択 -->
      <div class="upload-section">
        <p class="upload-section-title">ファイル選択</p>

        <div class="flex items-center gap-2 flex-wrap">
          <label :class="[$style.fileLabel, 'btn', 'btn-secondary']">
            ファイルを選択
            <input
              type="file"
              multiple
              :class="$style.hiddenInput"
              @change="e => { selectedFiles = Array.from((e.target as HTMLInputElement).files ?? []); selectedDir = null; selectedDirName = ''; }"
            >
          </label>
          <span v-if="selectedFiles.length > 0" class="badge badge-info">
            {{ selectedFiles.length }} ファイル選択済み
          </span>

          <template v-if="supportsFileAccessAPI">
            <Button.Root class="btn btn-secondary" @click="pickDirectory">
              <Button.Content>フォルダを選択</Button.Content>
            </Button.Root>
            <span v-if="selectedDirName" class="badge badge-info">{{ selectedDirName }}</span>
          </template>
        </div>

        <div v-if="selectedDir || (selectedFiles && selectedFiles.length > 0)" class="mt-3">
          <p class="form-label" :class="$style.archiveModeLabel">アップロード形式</p>
          <div :class="$style.archiveModeList">
            <label class="checkbox-label">
              <input v-model="archiveMode" type="radio" value="individual" :class="$style.radioInput">
              個別ファイルとしてアップロード
            </label>
            <label v-if="!selectedDir" class="checkbox-label">
              <input v-model="archiveMode" type="radio" value="gz" :class="$style.radioInput">
              gzip 圧縮してアップロード <span class="badge badge-muted" :class="$style.badgeMargin">.gz</span>
            </label>
            <label v-if="selectedDir" class="checkbox-label">
              <input v-model="archiveMode" type="radio" value="tar" :class="$style.radioInput">
              tar にまとめてアップロード <span class="badge badge-muted" :class="$style.badgeMargin">無圧縮</span>
            </label>
            <label v-if="selectedDir" class="checkbox-label">
              <input v-model="archiveMode" type="radio" value="targz" :class="$style.radioInput">
              tar.gz にまとめてアップロード <span class="badge badge-info" :class="$style.badgeMargin">BGZF・ランダムアクセス対応</span>
            </label>
          </div>
        </div>
      </div>

      <!-- オプション -->
      <div class="upload-section">
        <p class="upload-section-title">オプション</p>
        <div :class="$style.optionsList">
          <label class="radio-label">
            <input v-model="visibility" type="radio" value="public" :class="$style.radioInput">
            公開
          </label>
          <label class="radio-label">
            <input v-model="visibility" type="radio" value="private" :class="$style.radioInput">
            非公開
          </label>
          <label class="radio-label">
            <input v-model="visibility" type="radio" value="passphrase" :class="$style.radioInput">
            合言葉で保護
          </label>
          <div v-if="visibility === 'public'" class="form-hint">
            一度公開したファイルは非公開に戻せません。
          </div>
          <div v-if="visibility === 'passphrase'" :class="[$style.passphraseGroup, 'form-group']">
            <label class="form-label" for="upload-passphrase">合言葉</label>
            <input
              id="upload-passphrase"
              v-model="passphrase"
              class="form-input"
              type="text"
              placeholder="アクセス用の合言葉"
            >
          </div>
        </div>
      </div>

      <!-- 開始ボタン -->
      <div class="mt-4">
        <Button.Root
          class="btn btn-primary btn-lg"
          :disabled="!!uploadProgress && !uploadDone && !uploadError"
          @click="startUpload"
        >
          <Button.Content>アップロード開始</Button.Content>
        </Button.Root>
      </div>

      <!-- 進捗 -->
      <div v-if="uploadProgress" class="upload-progress-box mt-4">
        <p class="upload-progress-filename">
          <template v-if="uploadProgress.totalFiles > 0">
            <span class="badge badge-info" :class="$style.progressBadge">{{ uploadProgress.fileIndex }}/{{ uploadProgress.totalFiles }}</span>
          </template>
          {{ uploadProgress.filename || 'アーカイブ作成中...' }}
        </p>
        <Progress.Root
          class="progress-root"
          :model-value="uploadProgress.totalBytes > 0 ? Math.round(uploadProgress.uploadedBytes / uploadProgress.totalBytes * 100) : 0"
          :max="100"
        >
          <Progress.Track class="progress-track">
            <Progress.Fill class="progress-fill" />
          </Progress.Track>
        </Progress.Root>
        <p class="upload-progress-meta">
          {{ formatBytes(uploadProgress.uploadedBytes) }}
          <template v-if="uploadProgress.totalBytes > 0">
            / {{ formatBytes(uploadProgress.totalBytes) }}
            ({{ Math.round(uploadProgress.uploadedBytes / uploadProgress.totalBytes * 100) }}%)
          </template>
          <template v-else>転送済み</template>
        </p>
      </div>

      <div v-if="uploadError" class="alert alert-error mt-3">{{ uploadError }}</div>
      <div v-if="uploadDone" class="alert alert-success mt-3">
        アップロード完了！
        <NirA :to="`/v/${selectedBucketName}/`" :class="$style.doneLink">ファイル一覧を見る →</NirA>
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
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

.archiveModeLabel {
  margin-bottom: 8px;
}

.archiveModeList {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.radioInput {
  accent-color: var(--color-primary);
}

.badgeMargin {
  margin-left: 4px;
}

.optionsList {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.passphraseGroup {
  max-width: 320px;
}

.progressBadge {
  margin-right: 6px;
}

.doneLink {
  margin-left: 8px;
  font-weight: 600;
}
</style>
