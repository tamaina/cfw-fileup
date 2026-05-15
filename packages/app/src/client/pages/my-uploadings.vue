<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button } from '@vuetify/v0';
import NirA from '@/components/nira.vue';
import { authStore, authHeaders } from '@/store/auth';
import ConfirmDialog from '@/components/confirm-dialog.vue';

interface UploadEntry {
	id: string;
	bucketId: string;
	bucketName: string;
	path: string;
	size: number | null;
	isClosed: boolean;
	isPublic: boolean;
	uploadExpiresAt: number;
	isTargz: boolean;
	isTar: boolean;
}

const entries = ref<UploadEntry[]>([]);
const loading = ref(true);
const error = ref('');
const deleteErrors = ref<Record<string, string>>({});

const deleteDialog = ref(false);
const deleteTarget = ref<UploadEntry | null>(null);

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileLabel(e: UploadEntry): string {
	if (e.isTargz) return 'tar.gz';
	if (e.isTar) return 'tar';
	return '';
}

function browseLink(e: UploadEntry): string {
	return `/v/${e.bucketName}/${e.path}`;
}

async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch('/api/files/uploadings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({}),
		});
		if (!res.ok) { error.value = `取得失敗: ${res.status}`; return; }
		const data = await res.json() as { files: UploadEntry[] };
		entries.value = data.files;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

function requestDelete(entry: UploadEntry): void {
	deleteTarget.value = entry;
	deleteDialog.value = true;
}

async function executeDelete(): Promise<void> {
	if (!deleteTarget.value) return;
	const entry = deleteTarget.value;
	deleteDialog.value = false;
	deleteTarget.value = null;
	delete deleteErrors.value[entry.id];

	const res = await fetch(`/d/${entry.bucketName}/${entry.path}`, {
		method: 'DELETE',
		headers: authHeaders(),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({})) as { error?: string };
		deleteErrors.value[entry.id] = err.error ?? '削除失敗';
		return;
	}
	await load();
}

onMounted(load);
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">マイアップロード</h2>
    </div>

    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>
    <template v-else>
      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <div v-else-if="error" class="alert alert-error">{{ error }}</div>
      <template v-else>
        <div v-if="entries.length === 0" class="empty-state">
          <p>アップロードはありません。</p>
        </div>
        <div v-else class="card" style="padding:0; overflow:hidden">
          <table class="data-table">
            <thead>
              <tr>
                <th>バケット</th>
                <th>パス</th>
                <th class="col-right">サイズ</th>
                <th>種類</th>
                <th>状態</th>
                <th class="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in entries" :key="entry.id">
                <td class="col-muted">{{ entry.bucketName }}</td>
                <td>
                  <NirA v-if="entry.isClosed" :to="browseLink(entry)" class="font-mono">{{ entry.path }}</NirA>
                  <span v-else class="col-muted font-mono">{{ entry.path }}</span>
                </td>
                <td class="col-right col-muted">
                  {{ entry.size != null ? formatBytes(entry.size) : '' }}
                </td>
                <td>
                  <span v-if="fileLabel(entry)" class="badge badge-muted">{{ fileLabel(entry) }}</span>
                </td>
                <td>
                  <span v-if="entry.isClosed" class="badge badge-success">完了</span>
                  <span v-else class="badge badge-warning">アップロード中</span>
                </td>
                <td class="col-actions">
                  <div class="flex gap-2 items-center">
                    <Button.Root class="btn btn-ghost-danger btn-sm" @click="requestDelete(entry)">
                      <Button.Content>削除</Button.Content>
                    </Button.Root>
                    <span v-if="deleteErrors[entry.id]" class="text-danger" style="font-size:0.8rem">{{ deleteErrors[entry.id] }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <ConfirmDialog
      v-model:open="deleteDialog"
      :title="deleteTarget?.isClosed ? 'ファイルを削除' : 'アップロードをキャンセル'"
      :message="deleteTarget ? `「${deleteTarget.path}」を削除しますか？` : ''"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeDelete"
      @cancel="deleteDialog = false"
    />
  </div>
</template>
