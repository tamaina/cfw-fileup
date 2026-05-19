<script setup lang="ts">
defineProps<{ error?: Error }>();
</script>

<template>
  <div :class="$style.root" class="alert alert-error">
    <p :class="$style.title">コンポーネントの読み込みに失敗しました。</p>
    <pre v-if="error" :class="$style.pre">{{ error.message }}</pre>
  </div>
</template>

<style module lang="scss">
.root {
  flex-direction: column;
  gap: 8px;
  margin: 32px 0;
}

.title {
  margin: 0;
  font-weight: 600;
}

.pre {
  margin: 0;
  font-size: 0.8125rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
