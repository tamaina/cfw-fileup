<script setup lang="ts">
import { ref, onMounted } from 'vue';
import NirA from '@/components/nira.vue';
import { authStore, authHeaders } from '@/store/auth';

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

async function deleteEntry(entry: UploadEntry): Promise<void> {
	const label = entry.isClosed ? `ファイル「${entry.path}」` : `アップロード中のファイル「${entry.path}」`;
	if (!confirm(`${label}を削除しますか？`)) return;
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
    <h2>マイアップロード</h2>

    <p v-if="!authStore.user">ログインが必要です。</p>
    <template v-else>
      <p v-if="loading">読み込み中...</p>
      <p v-else-if="error" style="color:red">{{ error }}</p>
      <template v-else>
        <p v-if="entries.length === 0" style="color:#888">アップロードはありません。</p>
        <table v-else style="border-collapse:collapse; width:100%">
          <thead>
            <tr>
              <th style="text-align:left; padding:4px 8px">バケット</th>
              <th style="text-align:left; padding:4px 8px">パス</th>
              <th style="text-align:right; padding:4px 8px">サイズ</th>
              <th style="text-align:left; padding:4px 8px">種類</th>
              <th style="text-align:left; padding:4px 8px">状態</th>
              <th style="padding:4px 8px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.id">
              <td style="padding:4px 8px">{{ entry.bucketName }}</td>
              <td style="padding:4px 8px">
                <NirA v-if="entry.isClosed" :to="browseLink(entry)">{{ entry.path }}</NirA>
                <span v-else>{{ entry.path }}</span>
              </td>
              <td style="text-align:right; padding:4px 8px; color:#666">
                {{ entry.size != null ? formatBytes(entry.size) : '' }}
              </td>
              <td style="padding:4px 8px; color:#666">{{ fileLabel(entry) }}</td>
              <td style="padding:4px 8px">
                <span v-if="entry.isClosed" style="color:green">完了</span>
                <span v-else style="color:orange">アップロード中</span>
              </td>
              <td style="padding:4px 8px">
                <button type="button" style="font-size:0.8em" @click="deleteEntry(entry)">削除</button>
                <span v-if="deleteErrors[entry.id]" style="color:red; font-size:0.8em; margin-left:4px">{{ deleteErrors[entry.id] }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </template>
  </div>
</template>
