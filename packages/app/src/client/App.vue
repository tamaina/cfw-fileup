<script setup lang="ts">
import { ref } from 'vue';


let ok = ref(false);

const timer = setTimeout(() => {
  fetch('/ping')
    .then(res => res.text())
    .then(text => {
      if (text === 'pong') {
        ok.value = true;
      }
    });
}, 1000);
</script>

<template>
  <div class="container">
    <h1>CFW FileUp</h1>
    <p>Cloudflare Workersを使用したファイルアップロードサービス</p>
    <p v-if="ok">PING-PONG SUCCES!</p>
  </div>
</template>
