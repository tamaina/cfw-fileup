<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { authStore, authHeaders } from '../store/auth';
import NirA from '@/components/nira.vue';

interface AdminUser {
	id: string;
	username: string;
	isAdmin: boolean;
	isSuspended: boolean;
}

const userList = ref<AdminUser[]>([]);
const loading = ref(true);
const error = ref('');
const actionError = ref('');

onMounted(fetchUsers);

async function fetchUsers(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch('/api/admin/list-users', { headers: authHeaders() });
		if (!res.ok) throw new Error('ユーザー一覧の取得に失敗しました');
		userList.value = await res.json() as AdminUser[];
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function suspendUser(userId: string, username: string): Promise<void> {
	if (!confirm(`ユーザー "${username}" を停止しますか？ トークンも削除されます。`)) return;
	actionError.value = '';
	try {
		const res = await fetch('/api/admin/suspend-user', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ userId }),
		});
		if (!res.ok) throw new Error('停止に失敗しました');
		await fetchUsers();
	} catch (e) {
		actionError.value = String(e);
	}
}
</script>

<template>
  <div>
    <h2>ユーザー管理</h2>
    <NirA to="/admin">← 管理パネルに戻る</NirA>

    <div v-if="!authStore.user?.isAdmin" style="color:red; margin-top:12px">
      管理者権限が必要です。
    </div>

    <template v-else>
      <p v-if="error" style="color:red; margin-top:12px">{{ error }}</p>
      <p v-if="actionError" style="color:red">{{ actionError }}</p>

      <div v-if="loading" style="margin-top:12px">読み込み中...</div>

      <table v-else style="border-collapse:collapse; width:100%; margin-top:16px">
        <thead>
          <tr style="border-bottom:2px solid #ccc">
            <th style="text-align:left; padding:8px">ユーザー名</th>
            <th style="text-align:left; padding:8px">権限</th>
            <th style="text-align:left; padding:8px">状態</th>
            <th style="text-align:left; padding:8px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="u in userList"
            :key="u.id"
            style="border-bottom:1px solid #eee"
          >
            <td style="padding:8px">{{ u.username }}</td>
            <td style="padding:8px">
              <span v-if="u.isAdmin" style="color:#6200ea">管理者</span>
              <span v-else>一般</span>
            </td>
            <td style="padding:8px">
              <span v-if="u.isSuspended" style="color:red">停止中</span>
              <span v-else style="color:green">有効</span>
            </td>
            <td style="padding:8px; display:flex; gap:8px; flex-wrap:wrap">
              <NirA :to="`/admin/users/${u.id}`">クォータ設定</NirA>
              <button
                v-if="!u.isSuspended && u.id !== authStore.user?.id"
                type="button"
                @click="suspendUser(u.id, u.username)"
                style="color:red; border:none; background:none; cursor:pointer; padding:0"
              >
                停止
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
