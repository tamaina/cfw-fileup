<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Button, Progress } from '@vuetify/v0';
import { authHeaders, authStore } from '../store/auth';
import NirA from '@/components/nira.vue';
import { TarArchiver, BgzfTarArchiver, type TarIndex, type TarGzIndex, type ArchiveProgress } from 'bgzf';
import { takePendingUpload } from '@/store/pending-upload';

type ArchiveMode = 'individual' | 'gz' | 'tar' | 'targz';

const props = defineProps<{ bucketName: string }>();

interface Bucket {
	id: string;
	name: string;
}

const CHUNK_SIZE = 5 * 1024 * 1024;

const buckets = ref<Bucket[]>([]);
const selectedBucketName = ref(props.bucketName);
const bucket = computed(() => buckets.value.find(b => b.name === selectedBucketName.value) ?? null);
const loadError = ref('');

const selectedFiles = ref<File[]>([]);
const uploadPrefix = ref('');
const selectedDir = ref<FileSystemDirectoryHandle | null>(null);
const selectedDirName = ref('');
const archiveMode = ref<ArchiveMode>('individual');
const isPublic = ref(true);
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
	try {
		const res = await fetch('/api/buckets/list', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({}),
		});
		const data = (await res.json()) as { buckets?: Bucket[] };
		buckets.value = data.buckets ?? [];
	} catch (e) {
		loadError.value = String(e);
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
	const res = await fetch('/api/files/create/status', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ fileId }),
	}).catch(() => null);
	if (!res?.ok) return -1;
	const data = (await res.json().catch(() => null)) as { partCount: number } | null;
	return data?.partCount ?? -1;
}

async function tusUpload(fileId: string, blob: Blob, filename: string, onProgress?: (uploaded: number) => void): Promise<boolean> {
	const total = blob.size;
	let offset = Math.max(0, await getResumeOffset(fileId));
	onProgress?.(offset);

	while (offset < total) {
		const chunk = blob.slice(offset, offset + CHUNK_SIZE);
		const chunkIndex = offset / CHUNK_SIZE; // 0始まりのチャンク番号
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
						offset = partCount * CHUNK_SIZE;
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
	const res = await fetch(`/d/${selectedBucketName.value}/${path}`, {
		method: 'DELETE',
		headers: authHeaders(),
	});
	return res.ok;
}

async function openUpload(path: string): Promise<string | null> {
	if (!bucket.value) return null;
	const res = await fetch('/api/files/create/open', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ bucketId: bucket.value.id, path }),
	});
	const data = (await res.json()) as { fileId?: string; error?: string };
	if (!res.ok) { uploadError.value = data.error ?? 'アップロード開始失敗'; return null; }
	return data.fileId!;
}

async function closeUpload(fileId: string): Promise<boolean> {
	const res = await fetch('/api/files/create/close', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ fileId, isPublic: isPublic.value, passphrase: passphrase.value || undefined }),
	});
	if (!res.ok) {
		const err = (await res.json()) as { error?: string };
		uploadError.value = err.error ?? 'アップロード完了失敗';
		return false;
	}
	return true;
}

/** Upload a Blob (File or OPFS File) via TUS. */
async function uploadBlob(blob: Blob, path: string, onProgress?: (uploaded: number) => void): Promise<boolean> {
	const fileId = await openUpload(path);
	if (!fileId) return false;
	if (!(await tusUpload(fileId, blob, path, onProgress)) || !(await closeUpload(fileId))) {
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
	private onUploadedBytes?: (total: number) => void;
	private queueChain: Promise<boolean> = Promise.resolve(true);
	private hasError = false;
	private pendingUploads: Promise<boolean>[] = [];

	constructor(fileId: string, path: string, onUploadedBytes?: (total: number) => void) {
		this.fileId = fileId;
		this.path = path;
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

/** Open upload then stream in CHUNK_SIZE pieces via OPFS. Returns fileId or null on error. */
async function uploadChunkedStream(
	stream: ReadableStream<Uint8Array>,
	path: string,
	onUploadedBytes?: (total: number) => void,
): Promise<string | null> {
	const fileId = await openUpload(path);
	if (!fileId) return null;

	const reader = stream.getReader();
	const queue = new TusChunkQueue(fileId, path, onUploadedBytes);
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

			if (buf.length >= CHUNK_SIZE) {
				const chunk = buf.slice(0, CHUNK_SIZE);
				buf = buf.slice(CHUNK_SIZE);
				if (!(await queue.appendChunk(chunk, offset, partNum++, false))) {
					await deleteExistingFile(path);
					return null;
				}
				offset += chunk.length;
			}

			if (done) {
				// 残りのバッファを全て送信（5MB超過でも分割して対応）
				while (buf.length > 0) {
					const isFinal = buf.length <= CHUNK_SIZE;
					const chunk = isFinal ? buf : buf.slice(0, CHUNK_SIZE);
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

	const indexRes = await fetch('/api/files/create/tar-index', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ fileId, files: resolvedIndex }),
	});
	if (!indexRes.ok) {
		const err = (await indexRes.json()) as { error?: string };
		uploadError.value = err.error ?? 'インデックス登録失敗';
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

	const indexRes = await fetch('/api/files/create/targz-index', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ fileId, files: resolvedIndex }),
	});
	if (!indexRes.ok) {
		const err = (await indexRes.json()) as { error?: string };
		uploadError.value = err.error ?? 'インデックス登録失敗';
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
			const res = await fetch(`/d/${selectedBucketName.value}/${path}?meta`);
			if (res.ok) conflicts.push(path);
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
      <!-- バケット選択 -->
      <div class="upload-section">
        <p class="upload-section-title">バケット</p>
        <div class="form-group" style="max-width:280px">
          <select v-model="selectedBucketName" class="form-input">
            <option v-for="b in buckets" :key="b.id" :value="b.name">{{ b.name }}</option>
          </select>
        </div>
      </div>

      <!-- ファイル選択 -->
      <div class="upload-section">
        <p class="upload-section-title">ファイル選択</p>

        <div class="flex items-center gap-2 flex-wrap">
          <label class="btn btn-secondary" style="cursor:pointer">
            ファイルを選択
            <input
              type="file"
              multiple
              style="display:none"
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

        <div class="form-group mt-3" style="max-width:400px">
          <label class="form-label">アップロード先パス (任意)</label>
          <div class="form-row">
            <span class="form-hint font-mono" style="white-space:nowrap; padding:8px 4px 8px 0">{{ selectedBucketName }}/</span>
            <input
              v-model="uploadPrefix"
              class="form-input form-input-mono"
              type="text"
              placeholder="folder/path/"
            >
          </div>
        </div>

        <div v-if="selectedDir || (selectedFiles && selectedFiles.length > 0)" class="mt-3">
          <p class="form-label" style="margin-bottom:8px">アップロード形式</p>
          <div style="display:flex; flex-direction:column; gap:6px">
            <label class="checkbox-label">
              <input v-model="archiveMode" type="radio" value="individual" style="accent-color:var(--color-primary)">
              個別ファイルとしてアップロード
            </label>
            <label v-if="!selectedDir" class="checkbox-label">
              <input v-model="archiveMode" type="radio" value="gz" style="accent-color:var(--color-primary)">
              gzip 圧縮してアップロード <span class="badge badge-muted" style="margin-left:4px">.gz</span>
            </label>
            <label v-if="selectedDir" class="checkbox-label">
              <input v-model="archiveMode" type="radio" value="tar" style="accent-color:var(--color-primary)">
              tar にまとめてアップロード <span class="badge badge-muted" style="margin-left:4px">無圧縮</span>
            </label>
            <label v-if="selectedDir" class="checkbox-label">
              <input v-model="archiveMode" type="radio" value="targz" style="accent-color:var(--color-primary)">
              tar.gz にまとめてアップロード <span class="badge badge-info" style="margin-left:4px">BGZF・ランダムアクセス対応</span>
            </label>
          </div>
        </div>
      </div>

      <!-- オプション -->
      <div class="upload-section">
        <p class="upload-section-title">オプション</p>
        <div style="display:flex; flex-direction:column; gap:10px">
          <label class="checkbox-label">
            <input v-model="isPublic" type="checkbox" style="accent-color:var(--color-primary)">
            公開ファイル
          </label>
          <div class="form-group" style="max-width:320px">
            <label class="form-label" for="upload-passphrase">合言葉 (任意)</label>
            <input
              id="upload-passphrase"
              v-model="passphrase"
              class="form-input"
              type="text"
              placeholder="非公開ファイルのパスワード"
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
            <span class="badge badge-info" style="margin-right:6px">{{ uploadProgress.fileIndex }}/{{ uploadProgress.totalFiles }}</span>
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
        <NirA :to="`/v/${selectedBucketName}/`" style="margin-left:8px; font-weight:600">ファイル一覧を見る →</NirA>
      </div>
    </template>
  </div>
</template>
