<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { authHeaders, authStore } from '../store/auth';
import { createBgzfTar, type TarFileEntry } from 'bgzf';

const props = defineProps<{ bucketName: string }>();

interface Bucket {
	id: string;
	name: string;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB per TUS chunk

const bucket = ref<Bucket | null>(null);
const loadError = ref('');

// Upload form state
const selectedFiles = ref<FileList | null>(null);
const selectedDir = ref<FileSystemDirectoryHandle | null>(null);
const selectedDirName = ref('');
const useTarGz = ref(false);
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
		if (!bucket.value) {
			loadError.value = `バケット "${props.bucketName}" が見つかりません。`;
		}
	} catch (e) {
		loadError.value = String(e);
	}
}

async function pickDirectory(): Promise<void> {
	if (!supportsFileAccessAPI) return;
	try {
		const handle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
		selectedDir.value = handle;
		selectedDirName.value = handle.name;
		selectedFiles.value = null;
	} catch {
		// user cancelled
	}
}

async function* walkDirectory(
	dirHandle: FileSystemDirectoryHandle,
	prefix = '',
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
	for await (const [name, handle] of dirHandle as unknown as AsyncIterable<[string, FileSystemHandle]>) {
		if (handle.kind === 'file') {
			yield { path: prefix + name, handle: handle as FileSystemFileHandle };
		} else if (handle.kind === 'directory') {
			yield* walkDirectory(handle as FileSystemDirectoryHandle, prefix + name + '/');
		}
	}
}

async function tusUpload(fileId: string, data: ArrayBuffer, filename: string): Promise<boolean> {
	const total = data.byteLength;
	let offset = 0;
	while (offset < total) {
		const chunk = data.slice(offset, offset + CHUNK_SIZE);
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
		offset += chunk.byteLength;
		uploadProgress.value = {
			filename,
			percent: Math.round((offset / total) * 100),
		};
	}
	return true;
}

async function uploadSingleFile(file: File, path: string): Promise<boolean> {
	if (!bucket.value) return false;
	// 1. open
	const openRes = await fetch('/api/files/create/open', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ bucketId: bucket.value.id, path }),
	});
	const openData = (await openRes.json()) as { fileId?: string; error?: string };
	if (!openRes.ok) {
		uploadError.value = openData.error ?? 'アップロード開始失敗';
		return false;
	}
	const fileId = openData.fileId!;
	// 2. TUS upload
	const buf = await file.arrayBuffer();
	if (!(await tusUpload(fileId, buf, path))) return false;
	// 3. close
	const closeRes = await fetch('/api/files/create/close', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({
			fileId,
			isPublic: isPublic.value,
			passphrase: passphrase.value || undefined,
		}),
	});
	if (!closeRes.ok) {
		const err = (await closeRes.json()) as { error?: string };
		uploadError.value = err.error ?? 'アップロード完了失敗';
		return false;
	}
	return true;
}

async function uploadTarGz(entries: TarFileEntry[], archivePath: string): Promise<boolean> {
	if (!bucket.value) return false;
	uploadProgress.value = { filename: archivePath, percent: 0 };

	// 1. Build tar.gz
	const { data, index } = await createBgzfTar(entries);

	// 2. open
	const openRes = await fetch('/api/files/create/open', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ bucketId: bucket.value.id, path: archivePath }),
	});
	const openData = (await openRes.json()) as { fileId?: string; error?: string };
	if (!openRes.ok) {
		uploadError.value = openData.error ?? 'アップロード開始失敗';
		return false;
	}
	const fileId = openData.fileId!;

	// 3. TUS upload
	if (!(await tusUpload(fileId, data.buffer as ArrayBuffer, archivePath))) return false;

	// 4. Register tar.gz index
	const indexRes = await fetch('/api/files/create/targz-index', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ fileId, files: index }),
	});
	if (!indexRes.ok) {
		const err = (await indexRes.json()) as { error?: string };
		uploadError.value = err.error ?? 'インデックス登録失敗';
		return false;
	}

	// 5. close
	const closeRes = await fetch('/api/files/create/close', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({
			fileId,
			isPublic: isPublic.value,
			passphrase: passphrase.value || undefined,
		}),
	});
	if (!closeRes.ok) {
		const err = (await closeRes.json()) as { error?: string };
		uploadError.value = err.error ?? 'アップロード完了失敗';
		return false;
	}
	return true;
}

async function startUpload(): Promise<void> {
	uploadError.value = '';
	uploadDone.value = false;
	uploadProgress.value = null;

	if (!bucket.value) return;

	// Directory upload (File System Access API)
	if (selectedDir.value) {
		const entries: TarFileEntry[] = [];
		for await (const { path, handle } of walkDirectory(selectedDir.value)) {
			const file = await handle.getFile();
			const data = new Uint8Array(await file.arrayBuffer() as ArrayBuffer);
			const mimeType = file.type || 'application/octet-stream';
			entries.push({ path, data, mimeType, mtime: file.lastModified });
		}

		if (useTarGz.value) {
			const archivePath = `${selectedDirName.value}.tar.gz`;
			if (!(await uploadTarGz(entries, archivePath))) return;
		} else {
			for (const entry of entries) {
				uploadProgress.value = { filename: entry.path, percent: 0 };
				const file = new File([entry.data], entry.path, { type: entry.mimeType });
				if (!(await uploadSingleFile(file, entry.path))) return;
			}
		}
		uploadDone.value = true;
		return;
	}

	// Regular file(s)
	if (selectedFiles.value && selectedFiles.value.length > 0) {
		for (let i = 0; i < selectedFiles.value.length; i++) {
			const file = selectedFiles.value[i];
			if (!(await uploadSingleFile(file, file.name))) return;
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

        <div v-if="selectedDir" style="margin-top:8px">
          <label>
            <input v-model="useTarGz" type="checkbox">
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
        <a :href="`/v/${bucketName}/`">ファイル一覧を見る</a>
      </p>
    </template>
  </div>
</template>
