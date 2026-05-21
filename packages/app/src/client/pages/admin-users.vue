<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button, Popover } from '@vuetify/v0';
import { EllipsisVertical } from '@lucide/vue';
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
const unsuspendDialog = ref(false);
const unsuspendTarget = ref<AdminUser | null>(null);
const makeAdminDialog = ref(false);
const makeAdminTarget = ref<AdminUser | null>(null);

onMounted(fetchUsers);

async function fetchUsers(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/admin/list-users');
		if (!result.ok) throw new Error('ユーザー一覧の取得に失敗しました');
		userList.value = result.data;
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

function requestUnsuspend(user: AdminUser): void {
	unsuspendTarget.value = user;
	unsuspendDialog.value = true;
}

function requestMakeAdmin(user: AdminUser): void {
	makeAdminTarget.value = user;
	makeAdminDialog.value = true;
}

async function executeSuspend(): Promise<void> {
	if (!suspendTarget.value) return;
	const userId = suspendTarget.value.id;
	suspendDialog.value = false;
	suspendTarget.value = null;
	actionError.value = '';
	try {
		const result = await apiPost('/api/admin/suspend-user', { userId });
		if (!result.ok) throw new Error('停止に失敗しました');
		await fetchUsers();
	} catch (e) {
		actionError.value = String(e);
	}
}

async function executeUnsuspend(): Promise<void> {
	if (!unsuspendTarget.value) return;
	const userId = unsuspendTarget.value.id;
	unsuspendDialog.value = false;
	unsuspendTarget.value = null;
	actionError.value = '';
	try {
		const result = await apiPost('/api/admin/unsuspend-user', { userId });
		if (!result.ok) throw new Error('停止解除に失敗しました');
		await fetchUsers();
	} catch (e) {
		actionError.value = String(e);
	}
}

async function executeMakeAdmin(): Promise<void> {
	if (!makeAdminTarget.value) return;
	const userId = makeAdminTarget.value.id;
	makeAdminDialog.value = false;
	makeAdminTarget.value = null;
	actionError.value = '';
	try {
		const result = await apiPost('/api/admin/make-admin', { userId });
		if (!result.ok) throw new Error('管理者への変更に失敗しました');
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

      <div v-else :class="[$style.tableCard, 'card']">
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
              <td :class="$style.usernameCell">{{ u.username }}</td>
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
                  <Popover.Root v-if="u.id !== authStore.user?.id">
                    <Popover.Activator class="btn btn-ghost btn-icon" aria-label="操作メニュー">
                      <EllipsisVertical :size="16" :stroke-width="2" />
                    </Popover.Activator>
                    <Popover.Content class="action-menu">
                      <div class="action-menu-inner">
                        <Button.Root v-if="!u.isAdmin" class="btn btn-ghost w-full" :class="$style.menuItem" @click="requestMakeAdmin(u)">
                          <Button.Content>管理者にする</Button.Content>
                        </Button.Root>
                        <Button.Root v-if="!u.isSuspended" class="btn btn-ghost-danger w-full" :class="$style.menuItem" @click="requestSuspend(u)">
                          <Button.Content>停止</Button.Content>
                        </Button.Root>
                        <Button.Root v-else class="btn btn-ghost w-full" :class="$style.menuItem" @click="requestUnsuspend(u)">
                          <Button.Content>停止解除</Button.Content>
                        </Button.Root>
                      </div>
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
    <ConfirmDialog
      v-model:open="unsuspendDialog"
      title="ユーザーの停止を解除"
      :message="unsuspendTarget ? `ユーザー「${unsuspendTarget.username}」の停止を解除しますか？` : ''"
      confirm-label="解除する"
      @confirm="executeUnsuspend"
      @cancel="unsuspendDialog = false"
    />
    <ConfirmDialog
      v-model:open="makeAdminDialog"
      title="管理者にする"
      :message="makeAdminTarget ? `ユーザー「${makeAdminTarget.username}」を管理者にしますか？` : ''"
      confirm-label="管理者にする"
      @confirm="executeMakeAdmin"
      @cancel="makeAdminDialog = false"
    />
  </div>
</template>

<style module lang="scss">
.tableCard {
  padding: 0;
  overflow: hidden;
}

.usernameCell {
  font-weight: 500;
}

.menuItem {
  justify-content: flex-start;
}
</style>
