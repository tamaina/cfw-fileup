<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { Button } from '@vuetify/v0';
import BrowseDirectory from './browse.directory.vue';
import BrowseFile from './browse.file.vue';
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
const metaLoading = ref(false);
const metaError = ref('');
const fileIsPublic = ref(true);

const visibilityEditing = ref(false);
const editIsPublic = ref(true);
const editPassphrase = ref('');
const visibilitySaving = ref(false);
const visibilityError = ref('');

async function fetchMeta(): Promise<void> {
	if (isDirectory.value) {
		isTargz.value = false;
		return;
	}
	metaLoading.value = true;
	metaError.value = '';
	visibilityEditing.value = false;
	try {
		const res = await fetch(`/d/${props.bucketName}/${props.filePath}?meta`);
		if (!res.ok) { metaError.value = `取得失敗: ${res.status}`; return; }
		const data = await res.json() as { isTargz?: boolean; isPublic?: boolean };
		isTargz.value = data.isTargz ?? false;
		fileIsPublic.value = data.isPublic ?? true;
	} catch (e) {
		metaError.value = String(e);
	} finally {
		metaLoading.value = false;
	}
}

function startEditVisibility(): void {
	editIsPublic.value = fileIsPublic.value;
	editPassphrase.value = '';
	visibilityError.value = '';
	visibilityEditing.value = true;
}

async function saveVisibility(): Promise<void> {
	visibilitySaving.value = true;
	visibilityError.value = '';
	try {
		const res = await fetch('/api/files/update', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({
				bucketName: props.bucketName,
				filePath: props.filePath,
				isPublic: editIsPublic.value,
				passphrase: editPassphrase.value || undefined,
			}),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({})) as { error?: string };
			visibilityError.value = err.error ?? '保存失敗';
			return;
		}
		fileIsPublic.value = editIsPublic.value;
		visibilityEditing.value = false;
	} catch (e) {
		visibilityError.value = String(e);
	} finally {
		visibilitySaving.value = false;
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
      <!-- 公開設定（ファイルのみ・ログイン時） -->
      <div v-if="!isDirectory && authStore.user" class="card mb-3" style="padding: 12px 16px">
        <div class="flex items-center gap-3 flex-wrap">
          <span class="text-muted" style="font-size:0.875rem">公開設定</span>
          <span :class="fileIsPublic ? 'badge badge-success' : 'badge badge-muted'">
            {{ fileIsPublic ? '公開' : '非公開' }}
          </span>
          <Button.Root v-if="!visibilityEditing" class="btn btn-secondary btn-sm" @click="startEditVisibility">
            <Button.Content>変更</Button.Content>
          </Button.Root>
        </div>
        <template v-if="visibilityEditing">
          <div class="flex items-center gap-3 mt-2 flex-wrap">
            <label class="flex items-center gap-2" style="cursor:pointer">
              <input type="radio" v-model="editIsPublic" :value="true"> 公開
            </label>
            <label class="flex items-center gap-2" style="cursor:pointer">
              <input type="radio" v-model="editIsPublic" :value="false"> 非公開
            </label>
            <input
              v-if="!editIsPublic"
              v-model="editPassphrase"
              class="form-input form-input-mono"
              type="text"
              placeholder="パスフレーズ（任意）"
              style="width:200px"
            >
            <Button.Root class="btn btn-primary btn-sm" :disabled="visibilitySaving" @click="saveVisibility">
              <Button.Content>保存</Button.Content>
            </Button.Root>
            <Button.Root class="btn btn-secondary btn-sm" :disabled="visibilitySaving" @click="visibilityEditing = false">
              <Button.Content>キャンセル</Button.Content>
            </Button.Root>
          </div>
          <div v-if="visibilityError" class="mt-1" style="color:var(--color-danger); font-size:0.8rem">{{ visibilityError }}</div>
        </template>
      </div>

      <BrowseDirectory v-if="isDirectory || isTargz" :bucketName="bucketName" :filePath="filePath" :isTargz="isTargz" />
      <BrowseFile v-else :bucketName="bucketName" :filePath="filePath" />
    </template>
  </div>
</template>
