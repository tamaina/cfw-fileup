<script setup lang="ts">
	window.location.href = '/api-doc';
</script>

<template>
	<div :class="$style.root">
		<h1>API Documentation</h1>
		<p>Redirecting to <a href="/api-doc">/api-doc.html</a></p>
	</div>
</template>

<style module lang="scss">
.root {
  text-align: center;
  padding: 40px;
}
</style>
