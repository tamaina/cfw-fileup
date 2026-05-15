<script setup lang="ts">
defineProps<{ error?: Error }>();
</script>

<template>
  <div class="alert alert-error" style="flex-direction:column; gap:8px; margin: 32px 0">
    <p style="margin:0; font-weight:600">コンポーネントの読み込みに失敗しました。</p>
    <pre v-if="error" style="margin:0; font-size:0.8125rem; white-space:pre-wrap; overflow-wrap:anywhere">{{ error.message }}</pre>
  </div>
</template>
