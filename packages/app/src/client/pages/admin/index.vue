<script setup lang="ts">
import { ref } from 'vue';
import { authStore } from '@/store/auth';
import { apiPost } from '@/utils/api';
import NirA from '@/components/NirA.vue';

const purging = ref(false);
const error = ref('');
const success = ref('');

async function purgeWorkerCache(): Promise<void> {
	if (!confirm('Workerキャッシュを全パージしますか？')) return;

	purging.value = true;
	error.value = '';
	success.value = '';
	try {
		const result = await apiPost('/api/admin/purge-worker-cache');
		if (!result.ok) throw new Error(result.data.message);
		success.value = `Workerキャッシュをパージしました (${result.data.version})`;
	} catch (e) {
		error.value = String(e);
	} finally {
		purging.value = false;
	}
}
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">管理パネル</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <div v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>

      <div :class="$style.navWrapper">
        <ul class="admin-nav-list">
          <li><NirA to="/admin/settings">アプリ設定</NirA></li>
          <li><NirA to="/admin/global-quota">グローバルクォータ設定</NirA></li>
          <li><NirA to="/admin/plans">課金プラン管理</NirA></li>
          <li><NirA to="/admin/users">ユーザー管理</NirA></li>
          <li><NirA to="/admin/file-reports">ファイル通報</NirA></li>
          <li><NirA to="/admin/ip-bans">IP BAN管理</NirA></li>
        </ul>
      </div>

      <div :class="$style.maintenance">
        <h3 :class="$style.maintenanceTitle">メンテナンス</h3>
        <button class="btn btn-danger" type="button" :disabled="purging" @click="purgeWorkerCache">
          {{ purging ? 'パージ中...' : 'Workerキャッシュを全パージ' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style module lang="scss">
.navWrapper {
  max-width: 400px;
}

.maintenance {
  margin-top: 24px;
}

.maintenanceTitle {
  color: var(--color-text);
  margin: 0 0 12px;
  font-size: 1rem;
}
</style>
