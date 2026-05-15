<script setup lang="ts">
import { authStore } from '../store/auth';
import NirA from '@/components/nira.vue';
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">管理パネル</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <div v-else style="max-width:400px">
      <ul class="admin-nav-list">
        <li><NirA to="/admin/settings">アプリ設定</NirA></li>
        <li><NirA to="/admin/global-quota">グローバルクォータ設定</NirA></li>
        <li><NirA to="/admin/users">ユーザー管理</NirA></li>
      </ul>
    </div>
  </div>
</template>
