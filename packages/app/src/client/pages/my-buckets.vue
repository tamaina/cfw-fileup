<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { authHeaders, authStore } from '../store/auth';

interface Bucket {
	id: string;
	name: string;
}

const buckets = ref<Bucket[]>([]);
const error = ref('');
const loading = ref(true);
const newBucketName = ref('');
const creating = ref(false);
const createError = ref('');

async function loadBuckets(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch('/api/buckets/list', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({}),
		});
		const data = (await res.json()) as { buckets?: Bucket[]; error?: string };
		if (!res.ok) {
			error.value = data.error ?? 'バケット一覧の取得に失敗しました';
			return;
		}
		buckets.value = data.buckets ?? [];
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function createBucket(): Promise<void> {
	if (!newBucketName.value.trim()) return;
	creating.value = true;
	createError.value = '';
	try {
		const res = await fetch('/api/buckets/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ bucketName: newBucketName.value.trim() }),
		});
		const data = (await res.json()) as { bucketId?: string; error?: string };
		if (!res.ok) {
			createError.value = data.error ?? 'バケットの作成に失敗しました';
			return;
		}
		newBucketName.value = '';
		await loadBuckets();
	} catch (e) {
		createError.value = String(e);
	} finally {
		creating.value = false;
	}
}

async function deleteBucket(bucketId: string, bucketName: string): Promise<void> {
	if (!confirm(`バケット "${bucketName}" を削除しますか？ 中のファイルもすべて削除されます。`)) return;
	try {
		const res = await fetch('/api/buckets/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ bucketId }),
		});
		if (!res.ok) {
			const data = (await res.json()) as { error?: string };
			alert(data.error ?? '削除に失敗しました');
			return;
		}
		await loadBuckets();
	} catch (e) {
		alert(String(e));
	}
}

onMounted(loadBuckets);
</script>

<template>
  <div>
    <h2>マイバケット</h2>
    <p v-if="!authStore.user">ログインが必要です。</p>
    <template v-else>
      <form @submit.prevent="createBucket" style="margin-bottom:16px">
        <input v-model="newBucketName" type="text" placeholder="新しいバケット名" maxlength="64">
        <button type="submit" :disabled="creating">作成</button>
        <span v-if="createError" style="color:red; margin-left:8px">{{ createError }}</span>
      </form>
      <p v-if="loading">読み込み中...</p>
      <p v-else-if="error" style="color:red">{{ error }}</p>
      <ul v-else-if="buckets.length > 0">
        <li v-for="b in buckets" :key="b.id">
          <a :href="`/v/${b.name}/`">{{ b.name }}</a>
          &nbsp;
          <a :href="`/my/buckets/${b.name}/upload`">アップロード</a>
          &nbsp;
          <button type="button" @click="deleteBucket(b.id, b.name)">削除</button>
        </li>
      </ul>
      <p v-else>バケットがありません。</p>
    </template>
  </div>
</template>
