<script setup lang="ts">
import { ref } from 'vue';

let ok = ref(false);

let id = ref('')

const timer = setTimeout(() => {
  fetch('/ping')
    .then(res => res.text())
    .then(text => {
      if (text === 'pong') {
        ok.value = true;
      }
    });
  fetch('/id')
    .then(res => res.text())
    .then(text => {
      id.value = text;
    });
}, 1000);
</script>

<template>
  <div class="container">
    <h1>CFW FileUp</h1>
    <p>Cloudflare Workersを使用したファイルアップロードサービス</p>
    <p>{{ id }}</p>
    <p v-if="ok">PING-PONG SUCCESS!</p>
  </div>
</template>
