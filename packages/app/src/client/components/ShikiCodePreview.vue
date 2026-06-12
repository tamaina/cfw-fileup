<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{
	code: string;
	lang: 'json' | 'markdown';
}>();

const html = ref('');
const loading = ref(false);
const error = ref('');

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null;

async function createHighlighter() {
	const [
		{ createHighlighterCore },
		{ createJavaScriptRegexEngine },
		json,
		markdown,
		githubDark,
	] = await Promise.all([
		import('shiki/core'),
		import('shiki/engine/javascript'),
		import('shiki/langs/json.mjs'),
		import('shiki/langs/markdown.mjs'),
		import('shiki/themes/github-dark.mjs'),
	]);

	return createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		langs: [json.default, markdown.default],
		themes: [githubDark.default],
	});
}

const normalizedLang = computed(() => props.lang === 'markdown' ? 'markdown' : 'json');

watch(
	() => [props.code, props.lang] as const,
	async ([code]) => {
		html.value = '';
		error.value = '';
		if (!code) return;
		loading.value = true;
		try {
			highlighterPromise ??= createHighlighter();
			const highlighter = await highlighterPromise;
			html.value = highlighter.codeToHtml(code, {
				lang: normalizedLang.value,
				theme: 'github-dark',
			});
		} catch (err) {
			console.error('Code highlighting failed', err, { lang: props.lang });
			error.value = err instanceof Error ? err.message : String(err);
		} finally {
			loading.value = false;
		}
	},
	{ immediate: true },
);
</script>

<template>
  <div v-if="loading" class="page-loading">
    <span class="spinner"></span>読み込み中...
  </div>
  <div v-else-if="error" class="alert alert-error">{{ error }}</div>
  <div v-else class="shiki-code-preview" v-html="html"></div>
</template>

<style>
.shiki-code-preview {
  overflow: auto;
}

.shiki-code-preview pre {
  background: var(--color-surface) !important;
  margin: 0;
  padding: 24px;
  border-radius: var(--radius);
  line-height: 1.6;
  white-space: pre;
}

.shiki-code-preview code {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.875rem;
}
</style>
