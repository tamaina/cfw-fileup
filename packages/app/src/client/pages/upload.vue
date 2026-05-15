<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
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
    console.log(handle);
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

async function tusUpload(fileId: string, blob: Blob, filename: string, onProgress?: (uploaded: number) => void): Promise<boolean> {
	const total = blob.size;
	let offset = 0;
	while (offset < total) {
		const chunk = blob.slice(offset, offset + CHUNK_SIZE);
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
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			uploadError.value = `アップロード失敗 (${filename}): ${err.error ?? res.status}`;
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
	if (!(await tusUpload(fileId, blob, path, onProgress))) return false;
	return closeUpload(fileId);
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
		partNum: number,
		isFinal: boolean,
	): Promise<boolean> {
		const file = await handle.getFile();
		const extraHeaders: Record<string, string> = {
			'Content-Length': String(file.size),
		};
		if (isFinal) {
			extraHeaders['Upload-Final'] = '1';
		}
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

		const root = await navigator.storage.getDirectory();
		await root.removeEntry(tmpName).catch(() => {});

		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			uploadError.value = `アップロード失敗 (${this.path}): ${err.error ?? res.status}`;
			return false;
		}
		return true;
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
				const chunk = buf;
				buf = new Uint8Array(0);
				if (!(await queue.appendChunk(chunk, offset, partNum++, false))) {
					return null;
				}
				offset += chunk.length;
			}

			if (done) {
				if (buf.length > 0) {
					if (!(await queue.appendChunk(buf, offset, partNum, true))) {
						return null;
					}
					offset += buf.length;
				}
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	if (!(await queue.waitAll())) {
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
		return false;
	}

	return closeUpload(fileId);
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
		return false;
	}

	return closeUpload(fileId);
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
    <h2>アップロード - {{ selectedBucketName }}</h2>

    <p v-if="!authStore.user">ログインが必要です。</p>
    <p v-else-if="loadError" style="color:red">{{ loadError }}</p>
    <template v-else>
      <div style="margin-bottom:12px">
        <label>
          バケット:
          <select v-model="selectedBucketName">
            <option v-for="b in buckets" :key="b.id" :value="b.name">{{ b.name }}</option>
          </select>
        </label>
      </div>

      <section>
        <h3>ファイル選択</h3>

        <div>
          <input
            type="file"
            multiple
            @change="e => { selectedFiles = Array.from((e.target as HTMLInputElement).files ?? []); selectedDir = null; selectedDirName = ''; }"
          >
          <span v-if="selectedFiles.length > 0" style="margin-left:8px">{{ selectedFiles.length }} ファイル選択済み</span>
        </div>

        <div style="margin-top:8px">
          <label style="font-size:0.9em">
            アップロード先パス (任意):<br>
            <code style="font-size:1em">{{ selectedBucketName }}/</code><input
              v-model="uploadPrefix"
              type="text"
              placeholder="folder/path/"
              style="font-family:monospace; width:240px"
            >
          </label>
        </div>

        <div v-if="supportsFileAccessAPI" style="margin-top:8px">
          <button type="button" @click="pickDirectory">フォルダを選択 (File System Access API)</button>
          <span v-if="selectedDirName" style="margin-left:8px">選択済み: {{ selectedDirName }}</span>
        </div>

        <div v-if="selectedDir || (selectedFiles && selectedFiles.length > 0)" style="margin-top:8px">
          <p style="margin:0 0 4px">アップロード形式:</p>
          <label style="display:block">
            <input v-model="archiveMode" type="radio" value="individual">
            個別ファイルとしてアップロード
          </label>
          <label v-if="!selectedDir" style="display:block">
            <input v-model="archiveMode" type="radio" value="gz">
            gzip 圧縮してアップロード (.gz)
          </label>
          <label v-if="selectedDir" style="display:block">
            <input v-model="archiveMode" type="radio" value="tar">
            tar にまとめてアップロード (無圧縮)
          </label>
          <label v-if="selectedDir" style="display:block">
            <input v-model="archiveMode" type="radio" value="targz">
            tar.gz にまとめてアップロード (BGZF形式・ランダムアクセス対応)
          </label>
        </div>
      </section>

      <section style="margin-top:16px">
        <h3>オプション</h3>
        <label>
          <input v-model="isPublic" type="checkbox">
          公開ファイル
        </label>
        <div style="margin-top:8px">
          <label>合言葉(任意)<br>
            <input v-model="passphrase" type="text" placeholder="非公開ファイルのパスワード">
          </label>
        </div>
      </section>

      <div style="margin-top:16px">
        <button
          type="button"
          :disabled="!!uploadProgress && !uploadDone && !uploadError"
          @click="startUpload"
        >
          アップロード開始
        </button>
      </div>

      <div v-if="uploadProgress" style="margin-top:12px">
        <p>
          <template v-if="uploadProgress.totalFiles > 0">
            {{ uploadProgress.fileIndex }}/{{ uploadProgress.totalFiles }}:
          </template>
          {{ uploadProgress.filename }}
        </p>
        <p>
          {{ formatBytes(uploadProgress.uploadedBytes) }}
          <template v-if="uploadProgress.totalBytes > 0">
            / {{ formatBytes(uploadProgress.totalBytes) }}
            ({{ Math.round(uploadProgress.uploadedBytes / uploadProgress.totalBytes * 100) }}%)
          </template>
          <template v-else>転送済み</template>
        </p>
      </div>

      <p v-if="uploadError" style="color:red; margin-top:8px">{{ uploadError }}</p>
      <p v-if="uploadDone" style="color:green; margin-top:8px">
        アップロード完了！
        <NirA :to="`/v/${selectedBucketName}/`">ファイル一覧を見る</NirA>
      </p>
    </template>
  </div>
</template>
