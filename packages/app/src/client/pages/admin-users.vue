<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button, Popover } from '@vuetify/v0';
import { authStore } from '../store/auth';
import { apiPost } from '../utils/api';
import NirA from '@/components/nira.vue';
import ConfirmDialog from '@/components/confirm-dialog.vue';

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

const suspendDialog = ref(false);
const suspendTarget = ref<AdminUser | null>(null);

onMounted(fetchUsers);

async function fetchUsers(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const { res, data } = await apiPost<AdminUser[]>('/api/admin/list-users');
		if (!res.ok) throw new Error('ユーザー一覧の取得に失敗しました');
		userList.value = data;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

function requestSuspend(user: AdminUser): void {
	suspendTarget.value = user;
	suspendDialog.value = true;
}

async function executeSuspend(): Promise<void> {
	if (!suspendTarget.value) return;
	const userId = suspendTarget.value.id;
	suspendDialog.value = false;
	suspendTarget.value = null;
	actionError.value = '';
	try {
		const { res } = await apiPost('/api/admin/suspend-user', { userId });
		if (!res.ok) throw new Error('停止に失敗しました');
		await fetchUsers();
	} catch (e) {
		actionError.value = String(e);
	}
}
</script>

<template>
  <div>
    <NirA to="/admin" class="back-link">← 管理パネルに戻る</NirA>

    <div class="section-header">
      <h2 class="section-title">ユーザー管理</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="actionError" class="alert alert-error mb-4">{{ actionError }}</div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>

      <div v-else class="card" style="padding:0; overflow:hidden">
        <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>ユーザー名</th>
              <th>権限</th>
              <th>状態</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in userList" :key="u.id">
              <td style="font-weight:500">{{ u.username }}</td>
              <td>
                <span v-if="u.isAdmin" class="badge badge-admin">管理者</span>
                <span v-else class="badge badge-muted">一般</span>
              </td>
              <td>
                <span v-if="u.isSuspended" class="badge badge-danger">停止中</span>
                <span v-else class="badge badge-success">有効</span>
              </td>
              <td class="col-actions">
                <div class="flex gap-2 items-center">
                  <NirA :to="`/admin/users/${u.id}`" class="btn btn-secondary">クォータ設定</NirA>
                  <Popover.Root v-if="!u.isSuspended && u.id !== authStore.user?.id">
                    <Popover.Activator>
                      <Button.Root class="btn btn-ghost btn-icon" aria-label="操作メニュー">
                        <Button.Content>…</Button.Content>
                      </Button.Root>
                    </Popover.Activator>
                    <Popover.Content class="action-menu">
                      <Button.Root class="btn btn-ghost-danger w-full" style="justify-content:flex-start" @click="requestSuspend(u)">
                        <Button.Content>停止</Button.Content>
                      </Button.Root>
                    </Popover.Content>
                  </Popover.Root>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </template>

    <ConfirmDialog
      v-model:open="suspendDialog"
      title="ユーザーを停止"
      :message="suspendTarget ? `ユーザー「${suspendTarget.username}」を停止しますか？トークンも削除されます。` : ''"
      confirm-label="停止する"
      :danger="true"
      @confirm="executeSuspend"
      @cancel="suspendDialog = false"
    />
  </div>
</template>
