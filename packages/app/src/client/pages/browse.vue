<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import NirA from '@/components/nira.vue';

const props = withDefaults(defineProps<{
	bucketName: string;
	filePath?: string;
}>(), { filePath: '' });

interface TargzEntry {
	id: string;
	path: string;
	mimeType: string;
}

const isDirectory = computed(() => props.filePath === '' || props.filePath.endsWith('/'));
const targzEntries = ref<TargzEntry[]>([]);
const error = ref('');
const loading = ref(true);

const downloadUrl = computed(() => `/d/${props.bucketName}/${props.filePath}`);
const isImage = computed(() => {
	const ext = props.filePath.split('.').pop()?.toLowerCase() ?? '';
	return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext);
});
const isText = computed(() => {
	const ext = props.filePath.split('.').pop()?.toLowerCase() ?? '';
	return ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'yaml', 'yml', 'toml', 'sh', 'csv'].includes(ext);
});
const isTargz = computed(() => props.filePath.endsWith('.tar.gz') || props.filePath.endsWith('.tgz'));

async function loadTargzIndex(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const url = `${downloadUrl.value}?list`;
		const res = await fetch(url);
		if (!res.ok) {
			error.value = `取得失敗: ${res.status}`;
			return;
		}
		targzEntries.value = (await res.json()) as TargzEntry[];
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

function init(): void {
	if (isTargz.value) {
		loadTargzIndex();
	} else {
		loading.value = false;
	}
}

onMounted(init);
watch(() => props.filePath, init);
</script>

<template>
  <div>
    <h2>{{ bucketName }}/{{ filePath }}</h2>

    <p v-if="loading">読み込み中...</p>
    <p v-else-if="error" style="color:red">{{ error }}</p>

    <template v-else-if="isTargz">
      <h3>tar.gz 内容一覧</h3>
      <ul>
        <li v-for="entry in targzEntries" :key="entry.id">
          <NirA :to="`${downloadUrl}?file=${encodeURIComponent(entry.path)}`">
            {{ entry.path }}
          </NirA>
          <span style="color:#888; font-size:0.85em"> ({{ entry.mimeType }})</span>
        </li>
      </ul>
      <p v-if="targzEntries.length === 0">エントリがありません。</p>
    </template>

    <template v-else>
      <template v-if="isImage">
        <img :src="downloadUrl" :alt="filePath" style="max-width:100%; max-height:600px;">
        <br>
      </template>
      <p>
        <a :href="downloadUrl" download>ダウンロード</a>
      </p>
      <p v-if="isText">
        <a :href="downloadUrl" target="_blank">ブラウザで開く</a>
      </p>
    </template>
  </div>
</template>
