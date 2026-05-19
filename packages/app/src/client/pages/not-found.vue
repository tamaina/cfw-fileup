<script setup lang="ts">
import NirA from '@/components/nira.vue';
</script>

<template>
  <div :class="$style.root">
    <h1 :class="$style.code">404</h1>
    <p :class="$style.message">ページが見つかりません</p>
    <NirA to="/" class="btn btn-primary">トップへ戻る</NirA>
  </div>
</template>

<style module lang="scss">
.root {
  text-align: center;
  padding-top: 80px;
}

.code {
  font-size: 4rem;
  font-weight: 700;
  color: var(--color-text-subtle);
  margin-bottom: 8px;
}

.message {
  font-size: 1.125rem;
  margin-bottom: 24px;
}
</style>
