<script setup lang="ts">
import { ref, watch } from 'vue';
import { authHeaders } from '@/store/auth';
import { readTextPreview } from '@/utils/text-preview';

const props = defineProps<{
	url: string;
	filename: string;
}>();

const loading = ref(false);
const error = ref('');
const source = ref('');
const truncated = ref(false);

watch(
	() => props.url,
	async (url) => {
		source.value = '';
		error.value = '';
		truncated.value = false;
		if (!url) return;
		loading.value = true;
		try {
			const res = await fetch(url, { headers: authHeaders() });
			if (!res.ok) {
				error.value = `テキストを読み込めませんでした (${res.status})`;
				return;
			}
			const preview = await readTextPreview(res);
			source.value = preview.text;
			truncated.value = preview.truncated;
		} catch (err) {
			console.error('Raw text preview failed', err, { url, filename: props.filename });
			error.value = err instanceof Error ? err.message : String(err);
		} finally {
			loading.value = false;
		}
	},
	{ immediate: true },
);
</script>

<template>
  <section class="raw-text-preview-wrap" :aria-label="`${filename} のRawプレビュー`">
    <div v-if="!loading && !error && truncated" class="raw-text-preview-toolbar">
      <p class="raw-text-preview-note">ファイルが大きすぎるため、プレビューを省略しています。</p>
    </div>
    <div v-if="loading" class="page-loading">
      <span class="spinner"></span>読み込み中...
    </div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <div v-else class="raw-text-preview">
      <pre class="raw-text-preview-source">{{ source }}</pre>
    </div>
  </section>
</template>

<style>
.raw-text-preview-wrap {
  max-width: 880px;
}

.raw-text-preview-toolbar {
  display: flex;
  justify-content: flex-start;
  margin-bottom: 12px;
}

.raw-text-preview-note {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.raw-text-preview {
  padding: 24px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.raw-text-preview-source {
  margin: 0;
  color: var(--color-text);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
