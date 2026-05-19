<template>
  <div :class="$style.root">
    <span class="spinner" />
    <span>読み込み中...</span>
  </div>
</template>

<style module lang="scss">
.root {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--color-text-muted);
  padding: 32px 0;
  justify-content: center;
}
</style>
