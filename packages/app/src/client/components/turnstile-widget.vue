<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps<{ siteKey: string }>();
const emit = defineEmits<{ (e: 'update:token', token: string | null): void }>();

const container = ref<HTMLDivElement | null>(null);
let widgetId: string | undefined;

function loadScript(): Promise<void> {
	return new Promise((resolve, reject) => {
		if (document.querySelector('script[data-turnstile]')) { resolve(); return; }
		const s = document.createElement('script');
		s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		s.setAttribute('data-turnstile', '');
		s.onload = () => resolve();
		s.onerror = () => reject(new Error('Failed to load Turnstile script'));
		document.head.appendChild(s);
	});
}

onMounted(async () => {
	try {
		await loadScript();
	} catch (e) {
		console.error(e);
		return;
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const turnstile = (window as any).turnstile;
	if (!turnstile) {
		console.error('window.turnstile is not available');
		return;
	}
	widgetId = turnstile.render(container.value!, {
		sitekey: props.siteKey,
		callback: (token: string) => emit('update:token', token),
		'expired-callback': () => emit('update:token', null),
		'error-callback': () => emit('update:token', null),
	});
});

onUnmounted(() => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	if (widgetId) (window as any).turnstile?.remove(widgetId);
});

function reset(): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	if (widgetId) (window as any).turnstile?.reset(widgetId);
}

defineExpose({ reset });
</script>

<template>
  <div ref="container" />
</template>
