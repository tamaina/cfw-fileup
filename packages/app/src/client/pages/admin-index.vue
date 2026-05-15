<script setup lang="ts">
import { authStore } from '../store/auth';
import NirA from '@/components/nira.vue';
</script>

<template>
  <div>
    <h2>管理パネル</h2>

    <div v-if="!authStore.user?.isAdmin" style="color:red">
      管理者権限が必要です。
    </div>

    <ul v-else style="list-style:none; padding:0; display:grid; gap:8px; margin-top:16px; max-width:320px">
      <li><NirA to="/admin/settings">アプリ設定</NirA></li>
      <li><NirA to="/admin/global-quota">グローバルクォータ設定</NirA></li>
      <li><NirA to="/admin/users">ユーザー管理</NirA></li>
    </ul>
  </div>
</template>
