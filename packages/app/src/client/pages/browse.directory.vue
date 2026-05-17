<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { Button } from '@vuetify/v0';
import NirA from '@/components/nira.vue';
import { authStore, authHeaders } from '@/store/auth';
import { setPendingUpload } from '@/store/pending-upload';
import { mainRouter } from '@/router';
import ConfirmDialog from '@/components/confirm-dialog.vue';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	isTargz: boolean;
	isTar: boolean;
	entryPath?: string;
}>();

const isArchive = computed(() => props.isTargz || props.isTar);

interface DisplayEntry {
	key: string;
	name: string;
	link: string;
	isDir: boolean;
	fullPath: string;
	size?: number;
	label: string;
	isPublic?: boolean;
	/** 画像プレビューURL (画像MIMEタイプのファイルのみ) */
	previewUrl?: string;
}

const downloadUrl = computed(() => `/d/${props.bucketName}/${props.filePath}`);
const decompressUrl = computed(() => `/d/${props.bucketName}/${props.filePath}?decompress`);

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

const deleteDialog = ref(false);
const deleteTarget = ref<DisplayEntry | null>(null);
const archiveDeleteDialog = ref(false);

// ビューモード: list / grid (localStorageに保存して永続化)
type ViewMode = 'list' | 'grid';
const VIEW_MODE_KEY = 'cfw-fileup:dir-view-mode';
const viewMode = ref<ViewMode>((localStorage.getItem(VIEW_MODE_KEY) as ViewMode | null) ?? 'list');

function setViewMode(mode: ViewMode): void {
	viewMode.value = mode;
	localStorage.setItem(VIEW_MODE_KEY, mode);
}

/** MIMEタイプが画像かどうか */
function isImageMime(mime: string): boolean {
	return mime.startsWith('image/');
}

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
	try {
		if (isArchive.value) {
			const res = await fetch(`${downloadUrl.value}?list`, { headers: authHeaders() });
			if (!res.ok) { error.value = `取得失敗: ${res.status}`; return; }
			const raw = await res.json() as RawArchiveEntry[];
			archivePath.value = props.entryPath ?? '';
			allArchiveEntries.value = raw;
			buildArchiveEntries();
		} else {
			const res = await fetch(downloadUrl.value, { headers: authHeaders() });
			if (!res.ok) { error.value = `取得失敗: ${res.status}`; return; }
			const data = await res.json() as {
				entries: Array<{
					type: 'dir' | 'file'; name: string; path?: string;
					size?: number; mimeType?: string; isTargz?: boolean; isTar?: boolean; isPublic?: boolean;
				}>;
			};
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
				// 画像ファイルはプレビューURLを設定（ダウンロードURLを使用）
				const previewUrl = isImageMime(mime) ? `/d/${props.bucketName}/${e.path}` : undefined;
				return {
					key: `file:${e.name}`,
					name: e.name,
					link: `/v/${props.bucketName}/${e.path}`,
					isDir: false,
					fullPath: e.path ?? e.name,
					size: e.size,
					label: e.isTargz ? 'tar.gz' : e.isTar ? 'tar' : mime,
					isPublic: e.isPublic,
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

function goUpload(): void {
	setPendingUpload([], props.filePath);
	mainRouter.pushByPath(`/my/buckets/${props.bucketName}/upload`);
}

function onDragOver(e: DragEvent): void {
	if (isArchive.value || !authStore.user) return;
	e.preventDefault();
	isDragOver.value = true;
}

function onDragLeave(): void {
	isDragOver.value = false;
}

function onDrop(e: DragEvent): void {
	isDragOver.value = false;
	if (isArchive.value || !authStore.user) return;
	e.preventDefault();
	const droppedFiles = Array.from(e.dataTransfer?.files ?? []);
	if (droppedFiles.length === 0) return;
	setPendingUpload(droppedFiles, props.filePath);
	mainRouter.pushByPath(`/my/buckets/${props.bucketName}/upload`);
}

async function executeDeleteArchive(): Promise<void> {
	archiveDeleteDialog.value = false;
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
watch(() => props.entryPath, (newEntryPath) => {
	if (isArchive.value) {
		archivePath.value = newEntryPath ?? '';
		buildArchiveEntries();
	}
});
</script>

<template>
  <div>
    <!-- アーカイブ操作 -->
    <div v-if="isArchive" class="flex gap-2 items-center mb-3 flex-wrap">
      <a :href="downloadUrl" download class="btn btn-secondary">ダウンロード</a>
      <a v-if="isTargz" :href="decompressUrl" download class="btn btn-secondary">展開してダウンロード (.tar)</a>
      <Button.Root v-if="authStore.user" class="btn btn-ghost-danger" @click="archiveDeleteDialog = true">
        <Button.Content>削除</Button.Content>
      </Button.Root>
      <span v-if="deleteError" class="alert alert-error" style="padding:4px 10px; font-size:0.8rem">{{ deleteError }}</span>
    </div>

    <!-- 通常ディレクトリ操作 -->
    <div v-if="!isArchive && authStore.user" class="flex gap-2 items-center mb-3 flex-wrap">
      <Button.Root class="btn btn-primary" @click="goUpload">
        <Button.Content>アップロード</Button.Content>
      </Button.Root>
      <form class="flex gap-2 items-center" @submit.prevent="createDirectory">
        <input
          v-model="newDirName"
          class="form-input form-input-mono"
          type="text"
          placeholder="新しいフォルダ名"
          style="width:180px"
        >
        <Button.Root type="submit" class="btn btn-secondary" :disabled="!newDirName.trim() || !bucketId">
          <Button.Content>フォルダ作成</Button.Content>
        </Button.Root>
      </form>
      <span v-if="mkdirError" class="text-danger" style="font-size:0.8rem">{{ mkdirError }}</span>
    </div>

    <!-- ビュー切り替えボタン -->
    <div class="flex gap-1 items-center mb-3" style="justify-content: flex-end">
      <button
        :class="['btn btn-sm', viewMode === 'list' ? 'btn-primary' : 'btn-secondary']"
        title="リストビュー"
        @click="setViewMode('list')"
      >&#9776; リスト</button>
      <button
        :class="['btn btn-sm', viewMode === 'grid' ? 'btn-primary' : 'btn-secondary']"
        title="グリッドビュー"
        @click="setViewMode('grid')"
      >&#9638; グリッド</button>
    </div>

    <div v-if="loading" class="page-loading">
      <span class="spinner" />読み込み中...
    </div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <template v-else>
      <div v-if="deleteError" class="alert alert-error mb-3">{{ deleteError }}</div>

      <div
        class="drop-zone"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <div v-if="isDragOver" class="drop-zone-overlay">ここにドロップしてアップロード</div>

        <!-- リストビュー -->
        <template v-if="viewMode === 'list'">
          <div class="card" style="padding:0; overflow:hidden">
            <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
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
                    <button class="text-muted font-mono" style="font-size:0.875rem; background:none; border:none; cursor:pointer; padding:0" @click="navigateArchiveUp">..</button>
                  </td>
                </tr>
                <tr v-else-if="parentPath()">
                  <td :colspan="!isArchive && authStore.user && bucketId ? 5 : !isArchive && authStore.user ? 4 : 3">
                    <NirA :to="parentPath()!" class="text-muted font-mono" style="font-size:0.875rem">..</NirA>
                  </td>
                </tr>
                <tr v-for="entry in entries" :key="entry.key">
                  <td>
                    <button v-if="isArchive && entry.isDir" style="background:none; border:none; cursor:pointer; padding:0; font-weight:500; font-size:inherit; color:inherit" @click="navigateArchiveDir(entry.fullPath)">
                      <span style="margin-right:4px">📁</span>{{ entry.name }}
                    </button>
                    <NirA v-else-if="isArchive && !entry.isDir" :to="entry.link" style="font-weight:500">{{ entry.name }}</NirA>
                    <NirA v-else :to="entry.link" style="font-weight:500">
                      <span v-if="entry.isDir" style="margin-right:4px">📁</span>{{ entry.name }}
                    </NirA>
                  </td>
                  <td class="col-right col-muted">
                    {{ entry.size != null ? formatSize(entry.size) : '' }}
                  </td>
                  <td>
                    <span v-if="entry.label" class="badge badge-muted">{{ entry.label }}</span>
                  </td>
                  <td v-if="!isArchive && authStore.user">
                    <span v-if="!entry.isDir && entry.isPublic != null" :class="entry.isPublic ? 'badge badge-success' : 'badge badge-muted'">
                      {{ entry.isPublic ? '公開' : '非公開' }}
                    </span>
                  </td>
                  <td v-if="!isArchive && authStore.user && bucketId" class="col-actions">
                    <Button.Root class="btn btn-ghost-danger" @click="requestDeleteEntry(entry)">
                      <Button.Content>削除</Button.Content>
                    </Button.Root>
                  </td>
                </tr>
                <tr v-if="entries.length === 0">
                  <td :colspan="!isArchive && authStore.user && bucketId ? 5 : !isArchive && authStore.user ? 4 : 3">
                    <div class="empty-state">
                      <p>エントリがありません。</p>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </template>

        <!-- グリッドビュー -->
        <template v-else>
          <!-- 上へ -->
          <div v-if="isArchive && archivePath !== ''" class="mb-2">
            <button class="text-muted font-mono" style="font-size:0.875rem; background:none; border:none; cursor:pointer; padding:0" @click="navigateArchiveUp">..</button>
          </div>
          <div v-else-if="parentPath()" class="mb-2">
            <NirA :to="parentPath()!" class="text-muted font-mono" style="font-size:0.875rem">..</NirA>
          </div>

          <div v-if="entries.length === 0" class="empty-state card">
            <p>エントリがありません。</p>
          </div>
          <div v-else class="grid-view">
            <div
              v-for="entry in entries"
              :key="entry.key"
              class="grid-card"
            >
              <!-- プレビュー / アイコン -->
              <component
                :is="isArchive && entry.isDir ? 'button' : 'a'"
                class="grid-card-preview"
                :href="!(isArchive && entry.isDir) ? entry.link : undefined"
                :style="isArchive && entry.isDir ? 'background:none; border:none; width:100%; cursor:pointer; display:block; padding:0' : ''"
                @click="isArchive && entry.isDir ? navigateArchiveDir(entry.fullPath) : undefined"
              >
                <img
                  v-if="entry.previewUrl"
                  :src="entry.previewUrl"
                  :alt="entry.name"
                  class="grid-card-image"
                  loading="lazy"
                >
                <div v-else class="grid-card-icon">
                  <span v-if="entry.isDir" style="font-size:2.5rem">📁</span>
                  <span v-else style="font-size:2rem; color: var(--color-text-muted)">📄</span>
                </div>
              </component>

              <!-- ファイル情報 -->
              <div class="grid-card-info">
                <div class="grid-card-name" :title="entry.name">{{ entry.name }}</div>
                <div class="grid-card-meta">
                  <span v-if="entry.size != null" class="grid-card-size">{{ formatSize(entry.size) }}</span>
                  <span v-if="!entry.isDir && entry.isPublic != null && !isArchive" :class="entry.isPublic ? 'badge badge-success' : 'badge badge-muted'" style="font-size:0.65rem">
                    {{ entry.isPublic ? '公開' : '非公開' }}
                  </span>
                </div>
                <div v-if="!isArchive && authStore.user && bucketId" class="grid-card-actions">
                  <Button.Root class="btn btn-ghost-danger" style="font-size:0.75rem; padding:2px 8px" @click="requestDeleteEntry(entry)">
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

<style scoped>
/* グリッドビュー */
.grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.grid-card {
  border: 1px solid var(--color-border, #e0e0e0);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-surface, #fff);
  display: flex;
  flex-direction: column;
}

.grid-card-preview {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--color-background-muted, #f5f5f5);
  text-decoration: none;
}

.grid-card-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.grid-card-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.grid-card-info {
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.grid-card-name {
  font-size: 0.8rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-card-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.grid-card-size {
  font-size: 0.7rem;
  color: var(--color-text-muted, #888);
}

.grid-card-actions {
  margin-top: 2px;
}

/* ビュー切り替えボタン */
.btn-sm {
  padding: 4px 10px;
  font-size: 0.8rem;
}
</style>
