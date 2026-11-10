<script setup lang="ts">
import { authStore } from '@/store/auth';
import WalletRuntimeProvider from '@/components/WalletRuntimeProvider';
import RefundRequests from '@/components/RefundRequests.vue';
</script>
<template>
  <div>
    <h2 class="section-title">返金申請</h2>
    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">管理者権限が必要です。</div>
    <WalletRuntimeProvider v-else><RefundRequests admin /></WalletRuntimeProvider>
  </div>
</template>
