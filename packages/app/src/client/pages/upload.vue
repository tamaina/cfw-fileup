<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { authHeaders, authStore } from '../store/auth';
import NirA from '@/components/nira.vue';
import { TarArchiver, BgzfTarArchiver, type TarIndex, type TarGzIndex } from 'bgzf';

type ArchiveMode = 'individual' | 'gz' | 'tar' | 'targz';

const props = defineProps<{ bucketName: string }>();

interface Bucket {
	id: string;
	name: string;
}

const CHUNK_SIZE = 5 * 1024 * 1024;

const bucket = ref<Bucket | null>(null);
const loadError = ref('');

const selectedFiles = ref<FileList | null>(null);
const selectedDir = ref<FileSystemDirectoryHandle | null>(null);
const selectedDirName = ref('');
const archiveMode = ref<ArchiveMode>('individual');
const isPublic = ref(true);
const passphrase = ref('');
const uploadProgress = ref<{ filename: string; percent: number } | null>(null);
const uploadError = ref('');
const uploadDone = ref(false);

const supportsFileAccessAPI = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

async function loadBucket(): Promise<void> {
	try {
		const res = await fetch('/api/buckets/list', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({}),
		});
		const data = (await res.json()) as { buckets?: Bucket[] };
		bucket.value = data.buckets?.find((b) => b.name === props.bucketName) ?? null;
		if (!bucket.value) loadError.value = `バケット "${props.bucketName}" が見つかりません。`;
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
		selectedFiles.value = null;
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

async function tusUpload(fileId: string, blob: Blob, filename: string): Promise<boolean> {
	const total = blob.size;
	let offset = 0;
	while (offset < total) {
		const chunk = blob.slice(offset, offset + CHUNK_SIZE);
		const res = await fetch(`/upload/${fileId}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/offset+octet-stream',
				'Upload-Offset': String(offset),
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
		uploadProgress.value = { filename, percent: Math.round((offset / total) * 100) };
	}
	return true;
}

// ---- Core upload primitives ----

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
async function uploadBlob(blob: Blob, path: string): Promise<boolean> {
	uploadProgress.value = { filename: path, percent: 0 };
	const fileId = await openUpload(path);
	if (!fileId) return false;
	if (!(await tusUpload(fileId, blob, path))) return false;
	return closeUpload(fileId);
}

/** Write stream to OPFS, upload as blob, delete temp file. */
async function uploadStream(stream: ReadableStream<Uint8Array>, path: string): Promise<boolean> {
	const tmpName = `__up_${Date.now()}`;
	uploadProgress.value = { filename: path, percent: 0 };
	const handle = await streamToOpfs(stream, tmpName);
	const file = await handle.getFile();
	const ok = await uploadBlob(file, path);
	await deleteFromOpfs(tmpName);
	return ok;
}

/** Write tar stream to OPFS, upload, register index, delete temp file. */
async function uploadTarStream(
	stream: ReadableStream<Uint8Array>,
	index: Promise<TarIndex[]>,
	archivePath: string,
): Promise<boolean> {
	const tmpName = `__up_${Date.now()}`;
	uploadProgress.value = { filename: archivePath, percent: 0 };

	const handle = await streamToOpfs(stream, tmpName);
	const resolvedIndex = await index;
	const file = await handle.getFile();

	const fileId = await openUpload(archivePath);
	if (!fileId) { await deleteFromOpfs(tmpName); return false; }

	if (!(await tusUpload(fileId, file, archivePath))) {
		await deleteFromOpfs(tmpName);
		return false;
	}

	const indexRes = await fetch('/api/files/create/tar-index', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ fileId, files: resolvedIndex }),
	});
	if (!indexRes.ok) {
		const err = (await indexRes.json()) as { error?: string };
		uploadError.value = err.error ?? 'インデックス登録失敗';
		await deleteFromOpfs(tmpName);
		return false;
	}

	const ok = await closeUpload(fileId);
	await deleteFromOpfs(tmpName);
	return ok;
}

/** Write BGZF stream to OPFS, upload, register index, delete temp file. */
async function uploadBgzfStream(
	stream: ReadableStream<Uint8Array>,
	index: Promise<TarGzIndex[]>,
	archivePath: string,
): Promise<boolean> {
	const tmpName = `__up_${Date.now()}`;
	uploadProgress.value = { filename: archivePath, percent: 0 };

	const handle = await streamToOpfs(stream, tmpName);
	// stream is fully consumed here, so the index promise is now resolved
	const resolvedIndex = await index;
	const file = await handle.getFile();

	const fileId = await openUpload(archivePath);
	if (!fileId) { await deleteFromOpfs(tmpName); return false; }

	if (!(await tusUpload(fileId, file, archivePath))) {
		await deleteFromOpfs(tmpName);
		return false;
	}

	const indexRes = await fetch('/api/files/create/targz-index', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ fileId, files: resolvedIndex }),
	});
	if (!indexRes.ok) {
		const err = (await indexRes.json()) as { error?: string };
		uploadError.value = err.error ?? 'インデックス登録失敗';
		await deleteFromOpfs(tmpName);
		return false;
	}

	const ok = await closeUpload(fileId);
	await deleteFromOpfs(tmpName);
	return ok;
}

// ---- startUpload ----

async function startUpload(): Promise<void> {
	uploadError.value = '';
	uploadDone.value = false;
	uploadProgress.value = null;
	if (!bucket.value) return;

	// Directory (File System Access API)
	if (selectedDir.value) {
		if (archiveMode.value === 'individual') {
			for await (const { path, file } of TarArchiver.walkDirectory(selectedDir.value)) {
				if (!(await uploadBlob(file, path))) return;
			}
		} else if (archiveMode.value === 'tar') {
			const archiver = await TarArchiver.create(selectedDir.value);
			if (!(await uploadTarStream(archiver.stream, archiver.index, `${selectedDirName.value}.tar`))) return;
		} else {
			const archiver = await BgzfTarArchiver.create(selectedDir.value);
      console.log(archiver);
			if (!(await uploadBgzfStream(archiver.stream, archiver.index, `${selectedDirName.value}.tar.gz`))) return;
		}
		uploadDone.value = true;
		return;
	}

	// Regular file(s) — tar/bgzf modes are directory-only
	if (selectedFiles.value && selectedFiles.value.length > 0) {
		const fileArr = Array.from(selectedFiles.value);

		if (archiveMode.value === 'gz') {
			for (const file of fileArr) {
				const stream = file.stream().pipeThrough(new CompressionStream('gzip'));
				if (!(await uploadStream(stream, `${file.name}.gz`))) return;
			}
		} else {
			for (const file of fileArr) {
				if (!(await uploadBlob(file, file.name))) return;
			}
		}
		uploadDone.value = true;
	}
}

onMounted(loadBucket);
</script>

<template>
  <div>
    <h2>アップロード - {{ bucketName }}</h2>

    <p v-if="!authStore.user">ログインが必要です。</p>
    <p v-else-if="loadError" style="color:red">{{ loadError }}</p>
    <template v-else>
      <section>
        <h3>ファイル選択</h3>

        <div>
          <input
            type="file"
            multiple
            @change="e => { selectedFiles = (e.target as HTMLInputElement).files; selectedDir = null; selectedDirName = ''; }"
          >
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
        <p>{{ uploadProgress.filename }}: {{ uploadProgress.percent }}%</p>
      </div>

      <p v-if="uploadError" style="color:red; margin-top:8px">{{ uploadError }}</p>
      <p v-if="uploadDone" style="color:green; margin-top:8px">
        アップロード完了！
        <NirA :to="`/v/${bucketName}/`">ファイル一覧を見る</NirA>
      </p>
    </template>
  </div>
</template>
