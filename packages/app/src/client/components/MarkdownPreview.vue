<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { authHeaders } from '@/store/auth';
import ShikiCodePreview from './ShikiCodePreview.vue';

// Force all links to open in a new tab with safe rel attributes.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	if (node instanceof Element && node.tagName === 'A') {
		node.setAttribute('target', '_blank');
		node.setAttribute('rel', 'noopener noreferrer');
	}
});

const DOMPURIFY_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
	// Prevent CSS injection and phishing via form elements
	FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
	FORBID_ATTR: ['style'],
};

const props = defineProps<{
	url: string;
	filename: string;
}>();

const loading = ref(false);
const error = ref('');
const source = ref('');
const viewMode = ref<'formatted' | 'raw'>('formatted');
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const html = computed(() => {
	const rendered = marked.parse(source.value, {
		async: false,
		gfm: true,
		breaks: false,
	});
	return DOMPurify.sanitize(rendered, DOMPURIFY_CONFIG);
});

watch(
	() => props.url,
	async (url) => {
		source.value = '';
		error.value = '';
		if (!url) return;
		loading.value = true;
		try {
			const res = await fetch(url, { headers: authHeaders() });
			if (!res.ok) {
				error.value = `Markdownを読み込めませんでした (${res.status})`;
				return;
			}
			source.value = await res.text();
		} catch (err) {
			console.error('Markdown preview failed', err, { url, filename: props.filename });
			error.value = err instanceof Error ? err.message : String(err);
		} finally {
			loading.value = false;
		}
	},
	{ immediate: true },
);

async function copyRaw(): Promise<void> {
	if (!source.value) return;
	await navigator.clipboard.writeText(source.value);
	copied.value = true;
	if (copiedTimer !== null) clearTimeout(copiedTimer);
	copiedTimer = setTimeout(() => {
		copied.value = false;
		copiedTimer = null;
	}, 1600);
}

onBeforeUnmount(() => {
	if (copiedTimer !== null) clearTimeout(copiedTimer);
});
</script>

<template>
  <section class="markdown-preview-wrap" :aria-label="`${filename} のプレビュー`">
    <div v-if="!loading && !error" class="markdown-preview-toolbar">
      <div class="tab-bar markdown-preview-tabs" role="tablist" aria-label="Markdown表示">
        <button
          type="button"
          :class="['tab-btn', viewMode === 'formatted' ? 'tab-btn-active' : '']"
          :aria-selected="viewMode === 'formatted'"
          role="tab"
          @click="viewMode = 'formatted'"
        >整形</button>
        <button
          type="button"
          :class="['tab-btn', viewMode === 'raw' ? 'tab-btn-active' : '']"
          :aria-selected="viewMode === 'raw'"
          role="tab"
          @click="viewMode = 'raw'"
        >Raw</button>
      </div>
      <button
        v-if="viewMode === 'raw'"
        type="button"
        class="btn btn-secondary markdown-preview-copy"
        :disabled="source.length === 0"
        @click="copyRaw"
      >{{ copied ? 'コピー済み' : '全部コピー' }}</button>
    </div>
    <div v-if="loading" class="page-loading">
      <span class="spinner"></span>読み込み中...
    </div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <div v-else :class="['markdown-preview', viewMode === 'raw' && 'markdown-preview-raw-mode']">
      <ShikiCodePreview v-if="viewMode === 'raw'" :code="source" lang="markdown" />
      <div v-else class="markdown-body" v-html="html"></div>
    </div>
  </section>
</template>

<style>
.markdown-preview-wrap {
  max-width: 880px;
}

.markdown-preview {
  padding: 24px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.markdown-preview-raw-mode {
  padding: 0;
  overflow: hidden;
}

.markdown-preview-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.markdown-preview-tabs {
  flex: 1;
  min-width: 0;
}

.markdown-preview-copy {
  flex-shrink: 0;
}

.markdown-body {
  color: var(--color-text);
  line-height: 1.75;
  overflow-wrap: anywhere;
}

.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }

.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  line-height: 1.35;
  margin: 1.5em 0 0.65em;
  font-weight: 700;
}

.markdown-body h1 { font-size: 1.75rem; border-bottom: 1px solid var(--color-border); padding-bottom: 0.35em; }
.markdown-body h2 { font-size: 1.5rem; border-bottom: 1px solid var(--color-border); padding-bottom: 0.25em; }
.markdown-body h3 { font-size: 1.25rem; }
.markdown-body h4 { font-size: 1.1rem; }
.markdown-body h5 { font-size: 1rem; }
.markdown-body h6 { font-size: 0.95rem; color: var(--color-text-muted); }

.markdown-body p,
.markdown-body ul,
.markdown-body ol,
.markdown-body blockquote,
.markdown-body pre,
.markdown-body table { margin: 0 0 1em; }

.markdown-body ul,
.markdown-body ol { padding-left: 1.5em; }

.markdown-body a { color: var(--color-primary); }

.markdown-body blockquote {
  padding-left: 1em;
  color: var(--color-text-muted);
  border-left: 3px solid var(--color-border);
}

.markdown-body code {
  padding: 0.15em 0.35em;
  background: var(--color-bg);
  border-radius: 4px;
  font-size: 0.9em;
}

.markdown-body pre {
  padding: 12px;
  overflow-x: auto;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.markdown-body pre code {
  padding: 0;
  background: transparent;
  border-radius: 0;
}

.markdown-body table {
  display: block;
  width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}

.markdown-body th,
.markdown-body td {
  padding: 8px 10px;
  border: 1px solid var(--color-border);
}

.markdown-body img {
  max-width: 100%;
  height: auto;
}

</style>
