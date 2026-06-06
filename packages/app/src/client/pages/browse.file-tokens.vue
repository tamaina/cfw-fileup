<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { Button, Popover } from '@vuetify/v0';
import { EllipsisVertical } from '@lucide/vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import FileVisibilitySettings from '@/components/FileVisibilitySettings.vue';
import InfiniteTableRow from '@/components/InfiniteTableRow.vue';
import { apiPost } from '@/utils/api';
import type { FileVisibility } from '../../shared/file-visibility';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	fileVisibility: FileVisibility;
	isListed: boolean;
	downloadCount: number | null;
	isDownloadCountEnabled: boolean;
	isDownloadCountVisible: boolean;
	canUseDownloadCount: boolean;
	autoTokenId?: string | null;
}>();
const emit = defineEmits<{
	(e: 'update:fileVisibility', value: FileVisibility): void;
	(e: 'update:isListed', value: boolean): void;
	(e: 'update:isDownloadCountEnabled', value: boolean): void;
	(e: 'update:isDownloadCountVisible', value: boolean): void;
	(e: 'tokenDeleted', tokenId: string): void;
}>();

interface FileToken {
	id: string;
	expiresAt: number | null;
	createdAt: number;
}

const tokens = ref<FileToken[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const listError = ref('');
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);

const expiryMode = ref<'unlimited' | 'datetime' | 'duration'>('duration');
const datetimeDate = ref('');
const datetimeTime = ref('');
const durationValue = ref(1);
const durationUnit = ref<number>(86400);
const creating = ref(false);
const createError = ref('');
const createdToken = ref<{ id: string; token: string; expiresAt: number | null } | null>(null);
const copied = ref(false);
const publicCopied = ref(false);

const deleteDialogOpen = ref(false);
const deletingId = ref('');
const deleteError = ref('');

const editVisibility = ref<FileVisibility>(props.fileVisibility);
const editIsListed = ref(props.isListed);
const editIsDownloadCountEnabled = ref(props.isDownloadCountEnabled);
const editIsDownloadCountVisible = ref(props.isDownloadCountVisible);
const editPassphrase = ref('');
const visibilitySaving = ref(false);
const visibilityError = ref('');

async function loadTokens(cursor: string | null = null): Promise<void> {
	const isMore = cursor !== null;
	if (isMore) {
		loadingMore.value = true;
	} else {
		loading.value = true;
	}
	listError.value = '';
	try {
		const result = await apiPost('/api/file-tokens/list', { bucketName: props.bucketName, filePath: props.filePath, limit: 50, cursor });
		if (!result.ok) {
			listError.value = result.data.message;
			return;
		}
		tokens.value = cursor ? [...tokens.value, ...result.data.items] : result.data.items;
		nextCursor.value = result.data.nextCursor;
		hasMore.value = result.data.hasMore;
	} catch (e) {
		listError.value = String(e);
	} finally {
		if (isMore) {
			loadingMore.value = false;
		} else {
			loading.value = false;
		}
	}
}

function resolvedExpiresIn(): number | null {
	if (expiryMode.value === 'unlimited') return null;
	if (expiryMode.value === 'duration') return durationValue.value * durationUnit.value;
	// datetime
	const dt = new Date(`${datetimeDate.value}T${datetimeTime.value || '00:00'}`);
	return Math.floor((dt.getTime() - Date.now()) / 1000);
}

async function createToken(): Promise<void> {
	createError.value = '';
	const expiresIn = resolvedExpiresIn();
	if (expiryMode.value === 'datetime') {
		if (!datetimeDate.value) { createError.value = '日付を入力してください'; return; }
		if ((expiresIn ?? 1) <= 0) { createError.value = '期限は未来の日時を指定してください'; return; }
	}
	if (expiryMode.value === 'duration' && durationValue.value <= 0) {
		createError.value = '正の数を入力してください';
		return;
	}
	creating.value = true;
	createdToken.value = null;
	copied.value = false;
	try {
		const result = await apiPost('/api/file-tokens/create', {
			bucketName: props.bucketName,
			filePath: props.filePath,
			expiresIn,
		});
		if (!result.ok) {
			createError.value = result.data.message;
			return;
		}
		createdToken.value = result.data;
		await loadTokens();
	} catch (e) {
		createError.value = String(e);
	} finally {
		creating.value = false;
	}
}

function viewUrl(token?: string): string {
	const url = new URL(`/v/${props.bucketName}/${props.filePath}`, location.origin);
	if (token) url.searchParams.set('token', token);
	return url.toString();
}

async function copyUrl(): Promise<void> {
	if (!createdToken.value) return;
	await navigator.clipboard.writeText(viewUrl(createdToken.value.token));
	copied.value = true;
	setTimeout(() => { copied.value = false; }, 2000);
}

async function copyPublicUrl(): Promise<void> {
	await navigator.clipboard.writeText(viewUrl());
	publicCopied.value = true;
	setTimeout(() => { publicCopied.value = false; }, 2000);
}

function openDeleteDialog(id: string): void {
	deletingId.value = id;
	deleteError.value = '';
	deleteDialogOpen.value = true;
}

async function executeDelete(): Promise<void> {
	deleteError.value = '';
	try {
		const result = await apiPost('/api/file-tokens/delete', { tokenId: deletingId.value });
		if (!result.ok) {
			deleteError.value = result.data.message;
			return;
		}
		tokens.value = tokens.value.filter((t) => t.id !== deletingId.value);
		if (createdToken.value?.id === deletingId.value) createdToken.value = null;
		emit('tokenDeleted', deletingId.value);
	} catch (e) {
		deleteError.value = String(e);
	}
}

function formatDate(ms: number | null): string {
	if (ms === null) return '無制限';
	return new Date(ms).toLocaleString();
}

function isExpired(expiresAt: number | null): boolean {
	if (expiresAt === null) return false;
	return expiresAt < Date.now();
}

async function saveVisibility(): Promise<void> {
	visibilitySaving.value = true;
	visibilityError.value = '';
	try {
		const result = await apiPost('/api/files/update', {
			bucketName: props.bucketName,
			filePath: props.filePath,
			visibility: editVisibility.value,
			isListed: editIsListed.value,
			passphrase: editPassphrase.value || undefined,
			isDownloadCountEnabled: editIsDownloadCountEnabled.value,
			isDownloadCountVisible: editIsDownloadCountEnabled.value ? editIsDownloadCountVisible.value : false,
		});
		if (!result.ok) {
			visibilityError.value = result.data.message;
			return;
		}
		emit('update:fileVisibility', editVisibility.value);
		emit('update:isListed', editIsListed.value);
		emit('update:isDownloadCountEnabled', editIsDownloadCountEnabled.value);
		emit('update:isDownloadCountVisible', editIsDownloadCountEnabled.value ? editIsDownloadCountVisible.value : false);
	} catch (e) {
		visibilityError.value = String(e);
	} finally {
		visibilitySaving.value = false;
	}
}

watch(() => props.fileVisibility, (value) => {
	editVisibility.value = value;
});
watch(() => props.isListed, (value) => {
	editIsListed.value = value;
});
watch(() => props.isDownloadCountEnabled, (value) => {
	editIsDownloadCountEnabled.value = value;
});
watch(() => props.isDownloadCountVisible, (value) => {
	editIsDownloadCountVisible.value = value;
});

onMounted(loadTokens);
</script>

<template>
  <div>
    <!-- 公開設定 -->
    <div :class="[$style.sectionCard, 'card', 'mb-3']">
      <div :class="$style.visibilitySettings">
        <FileVisibilitySettings
          v-model:visibility="editVisibility"
          v-model:isListed="editIsListed"
          v-model:passphrase="editPassphrase"
          v-model:isDownloadCountEnabled="editIsDownloadCountEnabled"
          v-model:isDownloadCountVisible="editIsDownloadCountVisible"
          :can-use-download-count="canUseDownloadCount"
          :show-download-count-settings="true"
          :download-count="downloadCount"
          :lock-visibility="fileVisibility === 'public'"
          passphrase-autocomplete="off"
        />
        <Button.Root class="btn btn-primary" :disabled="visibilitySaving" @click="saveVisibility">
          <Button.Content>保存</Button.Content>
        </Button.Root>
      </div>
      <div v-if="visibilityError" :class="[$style.visibilityError, 'mt-1']">{{ visibilityError }}</div>
    </div>

    <!-- 発行フォーム -->
    <div v-if="fileVisibility === 'public'" :class="[$style.sectionCard, 'card', 'mb-3']">
      <div :class="[$style.sectionHeading, 'card-title', 'mb-2']">共有URL</div>
      <p :class="[$style.shareHint, 'text-muted']">
        「ファイル一覧とActivityPubに表示」がオンの公開ファイルは、ActivityPub対応サービスからこのリンクを照会できます。
      </p>
      <div class="flex items-center gap-2 flex-wrap">
        <pre :class="$style.tokenUrl"><code>{{ viewUrl() }}</code></pre>
        <Button.Root class="btn btn-secondary" @click="copyPublicUrl">
          <Button.Content>{{ publicCopied ? 'コピー済み' : 'コピー' }}</Button.Content>
        </Button.Root>
      </div>
    </div>
    <div v-else :class="[$style.sectionCard, 'card', 'mb-3']">
      <div :class="[$style.sectionHeading, 'card-title', 'mb-2']">新しい共有URLを発行</div>
      <p :class="[$style.shareHint, 'text-muted']">
        ActivityPubでのリンク照会は、公開ファイルで「ファイル一覧とActivityPubに表示」をオンにした場合に有効です。
      </p>

      <div class="flex items-center gap-3 flex-wrap">
        <select v-model="expiryMode" :class="[$style.expiryModeSelect, 'form-input']">
          <option value="unlimited">無制限</option>
          <option value="datetime">日時指定</option>
          <option value="duration">経過指定</option>
        </select>

        <!-- 日時指定 -->
        <template v-if="expiryMode === 'datetime'">
          <input v-model="datetimeDate" :class="[$style.dateInput, 'form-input']" type="date">
          <input v-model="datetimeTime" :class="[$style.timeInput, 'form-input']" type="time">
        </template>

        <!-- 経過指定 -->
        <template v-else-if="expiryMode === 'duration'">
          <input
            v-model.number="durationValue"
            :class="[$style.durationInput, 'form-input']"
            type="number"
            min="1"
          >
          <select v-model.number="durationUnit" :class="[$style.durationUnitSelect, 'form-input']">
            <option :value="60">分</option>
            <option :value="3600">時間</option>
            <option :value="86400">日</option>
          </select>
        </template>

        <Button.Root class="btn btn-primary" :disabled="creating" @click="createToken">
          <Button.Content>発行</Button.Content>
        </Button.Root>
      </div>
      <div v-if="createError" :class="[$style.createError, 'mt-2']">{{ createError }}</div>

      <!-- 発行後のトークン表示 -->
      <template v-if="createdToken">
        <div :class="[$style.createdTokenBox, 'mt-3']">
          <div :class="['text-muted', $style.createdTokenLabel, 'mb-1']">共有URL（この画面を閉じると再表示できません）</div>
          <div class="flex items-center gap-2 flex-wrap">
            <pre :class="$style.tokenUrl"><code>{{ viewUrl(createdToken.token) }}</code></pre>
            <Button.Root class="btn btn-secondary" @click="copyUrl">
              <Button.Content>{{ copied ? 'コピー済み' : 'コピー' }}</Button.Content>
            </Button.Root>
          </div>
          <div :class="[$style.expiryInfo, 'mt-1']">
            有効期限: {{ formatDate(createdToken.expiresAt) }}
          </div>
        </div>
      </template>
    </div>

    <!-- トークン一覧 -->
    <div v-if="fileVisibility !== 'public'" :class="[$style.sectionCard, 'card']">
      <div :class="[$style.sectionHeading, 'card-title', 'mb-2']">発行済み共有URL</div>
      <div v-if="loading" :class="['text-muted', $style.smallText]">読み込み中...</div>
      <div v-else-if="listError" :class="$style.listError">{{ listError }}</div>
      <div v-else-if="tokens.length === 0" :class="['text-muted', $style.smallText]">共有URLはありません</div>
      <div v-else :class="$style.tokenTableScroller">
        <table :class="[$style.tokenTable, 'data-table']">
          <thead>
            <tr>
              <th :class="$style.idCol">ID</th>
              <th>発行日時</th>
              <th>有効期限</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in tokens" :key="t.id">
              <td :class="$style.idCell">
                <div :class="$style.idContent">
                  <code :class="$style.tokenId">{{ t.id }}</code>
                  <span v-if="t.id === autoTokenId" class="badge badge-info" :class="$style.autoTokenBadge">
                    このビューで使用
                  </span>
                </div>
              </td>
              <td>{{ new Date(t.createdAt).toLocaleString() }}</td>
              <td>{{ formatDate(t.expiresAt) }}</td>
              <td>
                <span :class="isExpired(t.expiresAt) ? 'badge badge-muted' : 'badge badge-success'">
                  {{ isExpired(t.expiresAt) ? '期限切れ' : '有効' }}
                </span>
              </td>
              <td>
                <Popover.Root>
                  <Popover.Activator class="btn btn-ghost btn-icon" aria-label="操作メニュー">
                    <EllipsisVertical :size="16" :stroke-width="2" />
                  </Popover.Activator>
                  <Popover.Content class="action-menu">
                    <Button.Root class="btn btn-ghost-danger w-full" :class="$style.menuItem" @click="openDeleteDialog(t.id)">
                      <Button.Content>削除</Button.Content>
                    </Button.Root>
                  </Popover.Content>
                </Popover.Root>
              </td>
            </tr>
            <InfiniteTableRow
              v-if="hasMore || loadingMore"
              :colspan="5"
              :has-more="hasMore"
              :loading="loadingMore"
              @load-more="loadTokens(nextCursor)"
            />
          </tbody>
        </table>
      </div>
      <div v-if="deleteError" :class="[$style.deleteError, 'mt-2']">{{ deleteError }}</div>
    </div>

    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      title="共有URLを削除"
      message="この共有URLを削除します。削除後は使用できなくなります。"
      confirm-label="削除"
      :danger="true"
      @confirm="executeDelete"
    />
  </div>
</template>

<style module lang="scss">
.sectionCard {
  padding: 12px 16px;
}

.smallText {
  font-size: 0.875rem;
}

.visibilitySettings {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.visibilityError {
  color: var(--color-danger);
  font-size: 0.8rem;
}

.sectionHeading {
  font-size: 0.875rem;
  font-weight: 600;
}

.shareHint {
  margin: -4px 0 10px;
  font-size: 0.8rem;
  line-height: 1.5;
}

.expiryModeSelect {
  width: 120px;
}

.dateInput {
  width: 160px;
}

.timeInput {
  width: 120px;
}

.durationInput {
  width: 80px;
}

.durationUnitSelect {
  width: 100px;
}

.createError {
  color: var(--color-danger);
  font-size: 0.8rem;
}

.createdTokenBox {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 10px 12px;
}

.createdTokenLabel {
  font-size: 0.8rem;
}

.tokenUrl {
  font-size: 0.8rem;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  flex: 1;
}

.expiryInfo {
  font-size: 0.75rem;
  color: var(--color-muted);
}

.tokenTable {
  width: 100%;
  min-width: 640px;
  font-size: 0.875rem;
}

.tokenTableScroller {
  overflow-x: auto;
}

.idCol {
  width: 16em;
}

.idCell {
  max-width: 0;
}

.idContent {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.idContent .tokenId {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tokenId {
  font-size: 0.8rem;
}

.autoTokenBadge {
  flex: 0 0 auto;
}

.listError {
  color: var(--color-danger);
  font-size: 0.875rem;
}

.deleteError {
  color: var(--color-danger);
  font-size: 0.8rem;
}

.menuItem {
  justify-content: flex-start;
}
</style>
