<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import BrowseDirectory from './browse.directory.vue';
import BrowseFile from './browse.file.vue';
import BrowseFileTokens from './browse.file-tokens.vue';
import NirA from '@/components/nira.vue';
import { authStore, authHeaders } from '@/store/auth';

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
const isTar = ref(false);
const metaLoading = ref(false);
const metaError = ref('');
const fileIsPublic = ref(true);

const activeTab = ref<'info' | 'tokens'>('info');
const autoToken = ref<string | null>(null);

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
		const data = await res.json() as { isTargz?: boolean; isTar?: boolean; isPublic?: boolean };
		isTargz.value = data.isTargz ?? false;
		isTar.value = data.isTar ?? false;
		fileIsPublic.value = data.isPublic ?? true;
		if (!fileIsPublic.value && authStore.user) {
			await issueAutoToken();
		}
	} catch (e) {
		metaError.value = String(e);
	} finally {
		metaLoading.value = false;
	}
}

async function issueAutoToken(): Promise<void> {
	autoToken.value = null;
	try {
		const res = await fetch('/api/file-tokens/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ bucketName: props.bucketName, filePath: props.filePath, expiresIn: 3600 }),
		});
		if (res.ok) {
			const data = await res.json() as { token: string };
			autoToken.value = data.token;
		}
	} catch { /* silent */ }
}

onMounted(fetchMeta);
watch(() => [props.bucketName, props.filePath], () => {
	activeTab.value = 'info';
	autoToken.value = null;
	fetchMeta();
});
</script>

<template>
  <div>
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <nav class="breadcrumbs" style="margin-bottom:0">
        <template v-for="(seg, i) in breadcrumbs" :key="i">
          <span v-if="i > 0" class="breadcrumbs-sep">/</span>
          <NirA v-if="seg.link" :to="seg.link">{{ seg.name }}</NirA>
          <span v-else class="breadcrumbs-current">{{ seg.name }}</span>
        </template>
      </nav>
      <span
        v-if="!isDirectory && !metaLoading && !metaError"
        :class="fileIsPublic ? 'badge badge-success' : 'badge badge-muted'"
      >
        {{ fileIsPublic ? '公開' : '非公開' }}
      </span>
    </div>

    <div v-if="metaLoading" class="page-loading">
      <span class="spinner" />読み込み中...
    </div>
    <div v-else-if="metaError" class="alert alert-error">{{ metaError }}</div>
    <template v-else>
      <!-- ファイル・ログイン済み: タブ付きパネル -->
      <template v-if="!isDirectory && authStore.user">
        <div class="tab-bar mb-3">
          <button :class="['tab-btn', activeTab === 'info' ? 'tab-btn-active' : '']" @click="activeTab = 'info'">詳細</button>
          <button :class="['tab-btn', activeTab === 'tokens' ? 'tab-btn-active' : '']" @click="activeTab = 'tokens'">アクセストークン</button>
        </div>

        <!-- 詳細タブ: ファイル表示 -->
        <template v-if="activeTab === 'info'">
          <BrowseDirectory v-if="isTargz || isTar" :bucketName="bucketName" :filePath="filePath" :isTargz="isTargz" :isTar="isTar" />
          <BrowseFile v-else :bucketName="bucketName" :filePath="filePath" :token="autoToken ?? undefined" />
        </template>

        <!-- アクセストークンタブ: 公開設定 + トークン管理 -->
        <BrowseFileTokens
          v-else-if="activeTab === 'tokens'"
          :bucketName="bucketName"
          :filePath="filePath"
          :fileIsPublic="fileIsPublic"
          @update:fileIsPublic="fileIsPublic = $event"
        />
      </template>

      <!-- ログインなし or ディレクトリ: タブなし -->
      <template v-else>
        <BrowseDirectory v-if="isDirectory || isTargz || isTar" :bucketName="bucketName" :filePath="filePath" :isTargz="isTargz" :isTar="isTar" />
        <BrowseFile v-else-if="!isDirectory" :bucketName="bucketName" :filePath="filePath" />
      </template>
    </template>
  </div>
</template>
