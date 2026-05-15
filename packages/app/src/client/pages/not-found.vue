<script setup lang="ts">
import NirA from '@/components/nira.vue';
</script>

<template>
  <div class="empty-state" style="padding-top:80px">
    <h1 style="font-size:4rem; font-weight:700; color:var(--color-text-subtle); margin-bottom:8px">404</h1>
    <p style="font-size:1.125rem; margin-bottom:24px">ページが見つかりません</p>
    <NirA to="/" class="btn btn-primary">トップへ戻る</NirA>
  </div>
</template>
