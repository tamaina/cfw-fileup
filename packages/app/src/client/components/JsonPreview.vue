<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Content, JsonEditor } from 'vanilla-jsoneditor';
import 'vanilla-jsoneditor/themes/jse-theme-dark.css';
import { authHeaders } from '@/store/auth';
import ShikiCodePreview from './ShikiCodePreview.vue';

const props = defineProps<{
	url: string;
	filename: string;
}>();

const editorContainer = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const error = ref('');
const source = ref('');
const viewMode = ref<'formatted' | 'raw'>('raw');
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
let editor: JsonEditor | null = null;
let editorModulePromise: Promise<typeof import('vanilla-jsoneditor')> | null = null;

const parsedJson = computed<unknown | null>(() => {
	if (!source.value) return null;
	try {
		return JSON.parse(source.value) as unknown;
	} catch {
		return null;
	}
});

const parseError = computed(() => {
	if (!source.value) return '';
	try {
		JSON.parse(source.value);
		return '';
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
});

function destroyEditor(): void {
	editor?.destroy();
	editor = null;
}

async function renderEditor(): Promise<void> {
	await nextTick();
	if (loading.value || viewMode.value !== 'formatted' || !editorContainer.value || parsedJson.value == null) {
		destroyEditor();
		return;
	}
	const content: Content = { json: parsedJson.value };
	editorModulePromise ??= import('vanilla-jsoneditor');
	const { createJSONEditor } = await editorModulePromise;
	if (!editor) {
		editor = createJSONEditor({
			target: editorContainer.value,
			props: {
				content,
				mode: 'tree',
				readOnly: true,
				mainMenuBar: true,
				navigationBar: true,
				statusBar: true,
			},
		});
	} else {
		editor.updateProps({ content });
	}
}

watch(
	() => props.url,
	async (url) => {
		source.value = '';
		error.value = '';
		destroyEditor();
		if (!url) return;
		loading.value = true;
		try {
			const res = await fetch(url, { headers: authHeaders() });
			if (!res.ok) {
				error.value = `JSONを読み込めませんでした (${res.status})`;
				return;
			}
			source.value = await res.text();
		} catch (err) {
			console.error('JSON preview failed', err, { url, filename: props.filename });
			error.value = err instanceof Error ? err.message : String(err);
		} finally {
			loading.value = false;
			await renderEditor();
		}
	},
	{ immediate: true },
);

watch([viewMode, parsedJson, loading], () => {
	void renderEditor();
});

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
	destroyEditor();
});
</script>

<template>
  <section class="json-preview-wrap" :aria-label="`${filename} のJSONプレビュー`">
    <div v-if="!loading && !error" class="json-preview-toolbar">
      <div class="tab-bar json-preview-tabs" role="tablist" aria-label="JSON表示">
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
        class="btn btn-secondary json-preview-copy"
        :disabled="source.length === 0"
        @click="copyRaw"
      >{{ copied ? 'コピー済み' : '全部コピー' }}</button>
    </div>
    <div v-if="loading" class="page-loading">
      <span class="spinner"></span>読み込み中...
    </div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <div v-else-if="viewMode === 'formatted' && parseError" class="alert alert-error">
      JSONとして解釈できません: {{ parseError }}
    </div>
    <div v-else-if="viewMode === 'formatted'" class="json-preview json-preview-editor-wrap jse-theme-dark">
      <div ref="editorContainer" class="json-preview-editor"></div>
    </div>
    <div v-else class="json-preview">
      <ShikiCodePreview :code="source" lang="json" />
    </div>
  </section>
</template>

<style>
.json-preview-wrap {
  max-width: 960px;
}

.json-preview-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.json-preview-tabs {
  flex: 1;
  min-width: 0;
}

.json-preview-copy {
  flex-shrink: 0;
}

.json-preview {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.json-preview-editor-wrap {
  min-height: 420px;
  overflow: hidden;
}

.json-preview-editor {
  height: 560px;
  max-height: min(70vh, 720px);
}

.json-preview-editor-wrap.jse-theme-dark {
  --jse-theme-color: var(--color-primary);
  --jse-theme-color-highlight: var(--color-primary-hover);
  --jse-background-color: var(--color-surface);
  --jse-panel-background: var(--color-bg);
  --jse-panel-background-border: 1px solid var(--color-border);
  --jse-main-border: none;
}

</style>
