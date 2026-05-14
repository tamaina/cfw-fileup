<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import NirA from '@/components/nira.vue';
import { authStore, authHeaders } from '@/store/auth';
import { setPendingUpload } from '@/store/pending-upload';
import { mainRouter } from '@/router';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	isTargz: boolean;
}>();

interface DisplayEntry {
	key: string;
	name: string;
	link: string;
	isDir: boolean;
	fullPath: string;
	size?: number;
	label: string;
}

const downloadUrl = computed(() => `/d/${props.bucketName}/${props.filePath}`);

const entries = ref<DisplayEntry[]>([]);
const error = ref('');
const loading = ref(true);
const isDragOver = ref(false);
const deleteError = ref('');

const bucketId = ref<string | null>(null);
const newDirName = ref('');
const mkdirError = ref('');

async function loadBucketId(): Promise<void> {
	if (!authStore.user) return;
	const res = await fetch('/api/buckets/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({}),
	});
	if (!res.ok) return;
	const data = await res.json() as { buckets: Array<{ id: string; name: string }> };
	bucketId.value = data.buckets.find(b => b.name === props.bucketName)?.id ?? null;
}

async function createDirectory(): Promise<void> {
	const name = newDirName.value.trim();
	if (!name || !bucketId.value) return;
	mkdirError.value = '';
	const path = `${props.filePath}${name}/`;
	const res = await fetch('/api/directories/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ bucketId: bucketId.value, path }),
	});
	if (!res.ok) {
		const err = await res.json() as { error?: string };
		mkdirError.value = err.error ?? '作成失敗';
		return;
	}
	newDirName.value = '';
	await load();
}

async function deleteEntry(entry: DisplayEntry): Promise<void> {
	const label = entry.isDir ? `フォルダ「${entry.name}」とその中身` : `ファイル「${entry.name}」`;
	if (!confirm(`${label}を削除しますか？`)) return;
	deleteError.value = '';

	if (entry.isDir) {
		const res = await fetch('/api/directories/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ bucketId: bucketId.value, path: entry.fullPath }),
		});
		if (!res.ok) {
			const err = await res.json() as { error?: string };
			deleteError.value = err.error ?? '削除失敗';
			return;
		}
	} else {
		const res = await fetch(`/d/${props.bucketName}/${entry.fullPath}`, {
			method: 'DELETE',
			headers: authHeaders(),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({})) as { error?: string };
			deleteError.value = err.error ?? '削除失敗';
			return;
		}
	}
	await load();
}

async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		if (props.isTargz) {
			const res = await fetch(`${downloadUrl.value}?list`);
			if (!res.ok) { error.value = `取得失敗: ${res.status}`; return; }
			const raw = await res.json() as Array<{ id: string; path: string; mimeType: string }>;
			entries.value = raw.map(e => ({
				key: e.id,
				name: e.path,
				link: `${downloadUrl.value}?file=${encodeURIComponent(e.path)}`,
				isDir: false,
				fullPath: e.path,
				label: e.mimeType,
			}));
		} else {
			const res = await fetch(`${downloadUrl.value}?meta`);
			if (!res.ok) { error.value = `取得失敗: ${res.status}`; return; }
			const data = await res.json() as {
				entries: Array<{
					type: 'dir' | 'file'; name: string; path?: string;
					size?: number; mimeType?: string; isTargz?: boolean; isTar?: boolean;
				}>;
			};
			entries.value = data.entries.map(e => e.type === 'dir'
				? {
					key: `dir:${e.name}`,
					name: e.name,
					link: `/v/${props.bucketName}/${props.filePath}${e.name}/`,
					isDir: true,
					fullPath: `${props.filePath}${e.name}/`,
					label: 'フォルダ',
				}
				: {
					key: `file:${e.name}`,
					name: e.name,
					link: `/v/${props.bucketName}/${e.path}`,
					isDir: false,
					fullPath: e.path ?? e.name,
					size: e.size,
					label: e.isTargz ? 'tar.gz' : e.isTar ? 'tar' : (e.mimeType ?? ''),
				});
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

function parentPath(): string | null {
	if (!props.filePath || props.isTargz) return null;
	const parts = props.filePath.replace(/\/$/, '').split('/');
	parts.pop();
	return parts.length === 0
		? `/v/${props.bucketName}/`
		: `/v/${props.bucketName}/${parts.join('/')}/`;
}

function goUpload(): void {
	setPendingUpload([], props.filePath);
	mainRouter.pushByPath(`/my/buckets/${props.bucketName}/upload`);
}

function onDragOver(e: DragEvent): void {
	if (props.isTargz || !authStore.user) return;
	e.preventDefault();
	isDragOver.value = true;
}

function onDragLeave(): void {
	isDragOver.value = false;
}

function onDrop(e: DragEvent): void {
	isDragOver.value = false;
	if (props.isTargz || !authStore.user) return;
	e.preventDefault();
	const droppedFiles = Array.from(e.dataTransfer?.files ?? []);
	if (droppedFiles.length === 0) return;
	setPendingUpload(droppedFiles, props.filePath);
	mainRouter.pushByPath(`/my/buckets/${props.bucketName}/upload`);
}

async function deleteArchive(): Promise<void> {
	if (!confirm(`アーカイブ「${props.filePath}」を削除しますか？`)) return;
	deleteError.value = '';
	const res = await fetch(`/d/${props.bucketName}/${props.filePath}`, {
		method: 'DELETE',
		headers: authHeaders(),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({})) as { error?: string };
		deleteError.value = err.error ?? '削除失敗';
		return;
	}
	const parts = props.filePath.split('/');
	parts.pop();
	const parent = parts.length === 0
		? `/v/${props.bucketName}/`
		: `/v/${props.bucketName}/${parts.join('/')}/`;
	mainRouter.pushByPath(parent);
}

onMounted(() => { load(); loadBucketId(); });
watch(() => [props.bucketName, props.filePath], () => { load(); loadBucketId(); });
</script>

<template>
  <div>
    <div v-if="isTargz" style="margin-bottom:8px; display:flex; gap:8px; align-items:center">
      <a :href="downloadUrl" download>ダウンロード</a>
      <button v-if="authStore.user" type="button" @click="deleteArchive">削除</button>
      <span v-if="deleteError" style="color:red; font-size:0.9em">{{ deleteError }}</span>
    </div>

    <div v-if="!isTargz && authStore.user" style="margin-bottom:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap">
      <button type="button" @click="goUpload">アップロード</button>
      <form style="display:flex; gap:4px; align-items:center" @submit.prevent="createDirectory">
        <input v-model="newDirName" type="text" placeholder="新しいフォルダ名" style="width:160px">
        <button type="submit" :disabled="!newDirName.trim() || !bucketId">作成</button>
      </form>
      <span v-if="mkdirError" style="color:red; font-size:0.9em">{{ mkdirError }}</span>
    </div>

    <p v-if="loading">読み込み中...</p>
    <p v-else-if="error" style="color:red">{{ error }}</p>
    <template v-else>
      <p v-if="deleteError" style="color:red; font-size:0.9em">{{ deleteError }}</p>
      <div
        style="position:relative"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <div
          v-if="isDragOver"
          style="position:absolute; inset:0; background:rgba(0,100,255,0.08); border:2px dashed #4477ff; border-radius:4px; display:flex; align-items:center; justify-content:center; pointer-events:none; z-index:1"
        >
          ここにドロップしてアップロード
        </div>
        <table style="border-collapse:collapse; width:100%">
          <thead>
            <tr>
              <th style="text-align:left; padding:4px 8px">名前</th>
              <th style="text-align:right; padding:4px 8px">サイズ</th>
              <th style="text-align:left; padding:4px 8px">種類</th>
              <th v-if="!isTargz && authStore.user && bucketId" style="padding:4px 8px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="parentPath()">
              <td style="padding:4px 8px" colspan="4">
                <NirA :to="parentPath()!">..</NirA>
              </td>
            </tr>
            <tr v-for="entry in entries" :key="entry.key">
              <td style="padding:4px 8px">
                <NirA :to="entry.link">{{ entry.isDir ? '📁 ' : '' }}{{ entry.name }}</NirA>
              </td>
              <td style="text-align:right; padding:4px 8px; color:#666">
                {{ entry.size != null ? entry.size.toLocaleString() + ' B' : '' }}
              </td>
              <td style="padding:4px 8px; color:#666">{{ entry.label }}</td>
              <td v-if="!isTargz && authStore.user && bucketId" style="padding:4px 8px">
                <button type="button" style="font-size:0.8em" @click="deleteEntry(entry)">削除</button>
              </td>
            </tr>
            <tr v-if="entries.length === 0">
              <td colspan="4" style="padding:8px; color:#888">エントリがありません。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
