<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import BrowseDirectory from './browse.directory.vue';
import BrowseFile from './browse.file.vue';
import NirA from '@/components/nira.vue';

const props = withDefaults(defineProps<{
	bucketName: string;
	filePath?: string;
}>(), { filePath: '' });

const breadcrumbs = computed(() => {
	const parts = props.filePath ? props.filePath.replace(/\/$/, '').split('/') : [];
	const result: { name: string; link: string | null }[] = [];

	result.push({
		name: props.bucketName,
		link: parts.length === 0 ? null : `/v/${props.bucketName}/`,
	});

	for (let i = 0; i < parts.length; i++) {
		const isLast = i === parts.length - 1;
		const pathSoFar = parts.slice(0, i + 1).join('/') + '/';
		result.push({
			name: parts[i],
			link: isLast ? null : `/v/${props.bucketName}/${pathSoFar}`,
		});
	}

	return result;
});

const isDirectory = computed(() => props.filePath === '' || props.filePath.endsWith('/'));

const isTargz = ref(false);
const metaLoading = ref(false);
const metaError = ref('');

async function fetchMeta(): Promise<void> {
	if (isDirectory.value) {
		isTargz.value = false;
		return;
	}
	metaLoading.value = true;
	metaError.value = '';
	try {
		const res = await fetch(`/d/${props.bucketName}/${props.filePath}?meta`);
		if (!res.ok) { metaError.value = `取得失敗: ${res.status}`; return; }
		const data = await res.json() as { isTargz?: boolean };
		isTargz.value = data.isTargz ?? false;
	} catch (e) {
		metaError.value = String(e);
	} finally {
		metaLoading.value = false;
	}
}

onMounted(fetchMeta);
watch(() => [props.bucketName, props.filePath], fetchMeta);
</script>

<template>
  <div>
    <nav class="breadcrumbs">
      <template v-for="(seg, i) in breadcrumbs" :key="i">
        <span v-if="i > 0" class="breadcrumbs-sep">/</span>
        <NirA v-if="seg.link" :to="seg.link">{{ seg.name }}</NirA>
        <span v-else class="breadcrumbs-current">{{ seg.name }}</span>
      </template>
    </nav>

    <div v-if="metaLoading" class="page-loading">
      <span class="spinner" />読み込み中...
    </div>
    <div v-else-if="metaError" class="alert alert-error">{{ metaError }}</div>
    <template v-else>
      <BrowseDirectory v-if="isDirectory || isTargz" :bucketName="bucketName" :filePath="filePath" :isTargz="isTargz" />
      <BrowseFile v-else :bucketName="bucketName" :filePath="filePath" />
    </template>
  </div>
</template>
