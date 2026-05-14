<script setup lang="ts">
defineProps<{ error?: Error }>();
</script>

<template>
  <div style="padding: 16px; color: red;">
    <p>コンポーネントの読み込みに失敗しました。</p>
    <pre v-if="error">{{ error.message }}</pre>
  </div>
</template>
