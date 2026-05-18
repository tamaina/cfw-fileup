<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps<{ siteKey: string }>();
const emit = defineEmits<{ (e: 'update:token', token: string | null): void }>();

const container = ref<HTMLDivElement | null>(null);
let widgetId: string | undefined;

function loadScript(): Promise<void> {
	return new Promise((resolve) => {
		if (document.querySelector('script[data-turnstile]')) { resolve(); return; }
		const s = document.createElement('script');
		s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		s.setAttribute('data-turnstile', '');
		s.onload = () => resolve();
		document.head.appendChild(s);
	});
}

onMounted(async () => {
	await loadScript();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	widgetId = (window as any).turnstile.render(container.value!, {
		sitekey: props.siteKey,
		callback: (token: string) => emit('update:token', token),
		'expired-callback': () => emit('update:token', null),
		'error-callback': () => emit('update:token', null),
	});
});

onUnmounted(() => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	if (widgetId) (window as any).turnstile.remove(widgetId);
});
</script>

<template>
  <div ref="container" data-size="normal" />
</template>
