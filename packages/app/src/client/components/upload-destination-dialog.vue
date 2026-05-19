<script setup lang="ts">
import { ref, watch } from 'vue';
import { Dialog } from '@vuetify/v0';
import { apiPost } from '../utils/api';

const props = defineProps<{
	open: boolean;
}>();

const emit = defineEmits<{
	'update:open': [boolean];
	select: [{ bucketName: string; prefix: string }];
}>();

interface Bucket {
	id: string;
	name: string;
}

interface DirectoryEntry {
	type: 'dir' | 'file';
	name: string;
	path?: string;
}

const step = ref<'bucket' | 'directory'>('bucket');
const buckets = ref<Bucket[]>([]);
const selectedBucketId = ref('');
const selectedBucketName = ref('');
const currentPath = ref('');
const dirEntries = ref<DirectoryEntry[]>([]);
const loadingBuckets = ref(false);
const loadingDir = ref(false);
const bucketError = ref('');
const dirError = ref('');
const newDirName = ref('');
const mkdirError = ref('');
const showNewDirInput = ref(false);

async function loadBuckets(): Promise<void> {
	loadingBuckets.value = true;
	bucketError.value = '';
	const result = await apiPost('/api/buckets/list');
	loadingBuckets.value = false;
	if (!result.ok) {
		bucketError.value = result.data.error;
		return;
	}
	buckets.value = result.data.buckets;
	if (buckets.value.length > 0 && !selectedBucketId.value) {
		selectedBucketId.value = buckets.value[0].id;
		selectedBucketName.value = buckets.value[0].name;
	}
}

async function loadDirectory(): Promise<void> {
	loadingDir.value = true;
	dirError.value = '';
	const result = await apiPost('/api/files/ls', {
		bucketName: selectedBucketName.value,
		path: currentPath.value,
	});
	loadingDir.value = false;
	if (!result.ok) {
		dirError.value = result.data.error;
		return;
	}
	dirEntries.value = result.data.entries.filter(e => e.type === 'dir');
}

function selectBucket(bucket: Bucket): void {
	selectedBucketId.value = bucket.id;
	selectedBucketName.value = bucket.name;
}

async function goToDirectory(): Promise<void> {
	step.value = 'directory';
	currentPath.value = '';
	await loadDirectory();
}

async function enterDir(name: string): Promise<void> {
	currentPath.value = `${currentPath.value}${name}/`;
	await loadDirectory();
}

async function goUp(): Promise<void> {
	const parts = currentPath.value.replace(/\/$/, '').split('/');
	parts.pop();
	currentPath.value = parts.length === 0 ? '' : parts.join('/') + '/';
	await loadDirectory();
}

async function createDirectory(): Promise<void> {
	const name = newDirName.value.trim();
	if (!name || !selectedBucketId.value) return;
	mkdirError.value = '';
	const path = `${currentPath.value}${name}/`;
	const result = await apiPost('/api/directories/create', { bucketId: selectedBucketId.value, path });
	if (!result.ok) {
		mkdirError.value = result.data.error;
		return;
	}
	newDirName.value = '';
	showNewDirInput.value = false;
	await loadDirectory();
}

function confirmSelect(): void {
	emit('select', { bucketName: selectedBucketName.value, prefix: currentPath.value });
	emit('update:open', false);
}

function close(): void {
	emit('update:open', false);
}

watch(() => props.open, async (val) => {
	if (val) {
		step.value = 'bucket';
		currentPath.value = '';
		newDirName.value = '';
		mkdirError.value = '';
		showNewDirInput.value = false;
		await loadBuckets();
	}
});
</script>

<template>
  <Dialog.Root :model-value="open" @update:model-value="emit('update:open', $event)">
    <Dialog.Content :class="$style.dialog">
      <div :class="$style.inner">
        <div :class="$style.header">
          <Dialog.Title :class="$style.title">アップロード先を選択</Dialog.Title>
          <Dialog.Close class="btn btn-ghost" @click="close">✕</Dialog.Close>
        </div>

        <!-- Step 1: バケット選択 -->
        <template v-if="step === 'bucket'">
          <p :class="$style.stepLabel">バケットを選択してください</p>
          <div v-if="loadingBuckets" :class="$style.loadingText">読み込み中...</div>
          <div v-else-if="bucketError" class="alert alert-error">{{ bucketError }}</div>
          <div v-else :class="$style.bucketList">
            <label
              v-for="b in buckets"
              :key="b.id"
              :class="[$style.bucketItem, selectedBucketId === b.id && $style.bucketItemSelected]"
            >
              <input
                type="radio"
                :value="b.id"
                :checked="selectedBucketId === b.id"
                :class="$style.radio"
                @change="selectBucket(b)"
              >
              <span>{{ b.name }}</span>
            </label>
            <div v-if="buckets.length === 0" :class="$style.empty">バケットがありません</div>
          </div>
          <div :class="$style.actions">
            <button class="btn btn-secondary" @click="close">キャンセル</button>
            <button
              class="btn btn-primary"
              :disabled="!selectedBucketId"
              @click="goToDirectory"
            >
              次へ →
            </button>
          </div>
        </template>

        <!-- Step 2: ディレクトリ選択 -->
        <template v-else>
          <p :class="$style.stepLabel">ディレクトリを選択してください</p>
          <div v-if="loadingDir" :class="$style.loadingText">読み込み中...</div>
          <div v-else-if="dirError" class="alert alert-error">{{ dirError }}</div>
          <div v-else :class="$style.directoryList">
            <button
              v-if="currentPath !== ''"
              :class="[$style.directoryItem, $style.upItem]"
              @click="goUp"
            >
              ← 上へ
            </button>
            <button
              v-for="entry in dirEntries"
              :key="entry.name"
              :class="$style.directoryItem"
              @click="enterDir(entry.name)"
            >
              📁 {{ entry.name }}
            </button>
            <div v-if="dirEntries.length === 0 && currentPath === ''" :class="$style.empty">
              ディレクトリがありません
            </div>
          </div>

          <!-- 新規フォルダ作成 -->
          <div :class="$style.mkdirArea">
            <button
              v-if="!showNewDirInput"
              class="btn btn-secondary btn-sm"
              @click="showNewDirInput = true"
            >
              + 新規フォルダ作成
            </button>
            <div v-else :class="$style.mkdirRow">
              <input
                v-model="newDirName"
                class="form-input form-input-mono"
                type="text"
                placeholder="フォルダ名"
                @keydown.enter="createDirectory"
              >
              <button
                class="btn btn-secondary btn-sm"
                :disabled="!newDirName.trim()"
                @click="createDirectory"
              >
                作成
              </button>
              <button class="btn btn-ghost btn-sm" @click="showNewDirInput = false; newDirName = ''">
                キャンセル
              </button>
            </div>
            <p v-if="mkdirError" :class="$style.mkdirError">{{ mkdirError }}</p>
          </div>

          <p :class="$style.currentPath">
            <span :class="$style.bucketPart">{{ selectedBucketName }}/</span><span>{{ currentPath }}</span>
          </p>

          <div :class="$style.actions">
            <button class="btn btn-secondary" @click="step = 'bucket'">← バケット選択へ</button>
            <button class="btn btn-primary" @click="confirmSelect">ここを選択</button>
          </div>
        </template>
      </div>
    </Dialog.Content>
  </Dialog.Root>
</template>

<style module lang="scss">
.dialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  width: min(480px, calc(100vw - 32px));
  min-height: min(520px, calc(100vh - 64px));
  max-height: 80vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.inner {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: inherit;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
}

.stepLabel {
  font-size: 0.875rem;
  color: var(--color-text-muted);
  margin: 0;
}

.currentPath {
  font-family: monospace;
  font-size: 0.875rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 8px 10px;
  margin: 0;
  word-break: break-all;
}

.bucketPart {
  font-weight: 600;
}

.loadingText {
  font-size: 0.875rem;
  color: var(--color-text-muted);
}

.bucketList {
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bucketItem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  cursor: pointer;
  font-size: 0.875rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  text-align: left;
  width: 100%;
  color: var(--color-text);

  &:hover {
    background: var(--color-surface-hover, rgba(0, 0, 0, 0.04));
  }
}

.bucketItemSelected {
  background: var(--color-primary-surface, rgba(var(--color-primary-rgb, 0, 100, 200), 0.08));
  border-color: var(--color-primary);
}

.directoryList {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
}

.directoryItem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 0.875rem;
  border: none;
  background: transparent;
  text-align: left;
  width: 100%;
  color: var(--color-text);

  &:not(:last-child) {
    border-bottom: 1px solid var(--color-border);
  }

  &:hover {
    background: var(--color-surface-hover, rgba(0, 0, 0, 0.04));
  }
}

.upItem {
  font-weight: 500;
  color: var(--color-text-muted);
}

.empty {
  padding: 12px;
  font-size: 0.875rem;
  color: var(--color-text-muted);
  text-align: center;
  padding: 12px;
}

.radio {
  accent-color: var(--color-primary);
  flex-shrink: 0;
}

.mkdirArea {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mkdirRow {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;

  :global(.form-input) {
    border-radius: var(--radius);
  }
}

.mkdirError {
  font-size: 0.8rem;
  color: var(--color-danger, #e53e3e);
  margin: 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
