<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button, Popover } from '@vuetify/v0';
import ConfirmDialog from '@/components/confirm-dialog.vue';
import { apiPost } from '@/utils/api';
import type { FileVisibility } from '../../shared/file-visibility';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	fileVisibility: FileVisibility;
	autoTokenId?: string | null;
}>();
const emit = defineEmits<{
	(e: 'update:fileVisibility', value: FileVisibility): void;
	(e: 'tokenDeleted', tokenId: string): void;
}>();

interface FileToken {
	id: string;
	expiresAt: number | null;
	createdAt: number;
}

const tokens = ref<FileToken[]>([]);
const loading = ref(false);
const listError = ref('');

const expiryMode = ref<'unlimited' | 'datetime' | 'duration'>('duration');
const datetimeDate = ref('');
const datetimeTime = ref('');
const durationValue = ref(1);
const durationUnit = ref<number>(86400);
const creating = ref(false);
const createError = ref('');
const createdToken = ref<{ id: string; token: string; expiresAt: number | null } | null>(null);
const copied = ref(false);

const deleteDialogOpen = ref(false);
const deletingId = ref('');
const deleteError = ref('');

const editVisibility = ref<FileVisibility>(props.fileVisibility);
const editPassphrase = ref('');
const visibilitySaving = ref(false);
const visibilityError = ref('');

async function loadTokens(): Promise<void> {
	loading.value = true;
	listError.value = '';
	try {
		const result = await apiPost('/api/file-tokens/list', { bucketName: props.bucketName, filePath: props.filePath });
		if (!result.ok) {
			listError.value = result.data.error;
			return;
		}
		tokens.value = result.data.tokens.sort((a, b) => b.createdAt - a.createdAt);
	} catch (e) {
		listError.value = String(e);
	} finally {
		loading.value = false;
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
			createError.value = result.data.error;
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

function downloadUrl(token: string): string {
	return `${location.origin}/d/${props.bucketName}/${props.filePath}?token=${token}`;
}

async function copyUrl(): Promise<void> {
	if (!createdToken.value) return;
	await navigator.clipboard.writeText(downloadUrl(createdToken.value.token));
	copied.value = true;
	setTimeout(() => { copied.value = false; }, 2000);
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
			deleteError.value = result.data.error;
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
			passphrase: editPassphrase.value || undefined,
		});
		if (!result.ok) {
			visibilityError.value = result.data.error;
			return;
		}
		emit('update:fileVisibility', editVisibility.value);
	} catch (e) {
		visibilityError.value = String(e);
	} finally {
		visibilitySaving.value = false;
	}
}

onMounted(loadTokens);
</script>

<template>
  <div>
    <!-- 公開設定 -->
    <div :class="[$style.sectionCard, 'card', 'mb-3']">
      <div :class="[$style.sectionHeading, 'text-muted', 'mb-2']">公開設定</div>
      <div v-if="fileVisibility === 'public'" :class="['text-muted', $style.smallText]">
        公開ファイルの設定は変更できません。
      </div>
      <template v-else>
        <div class="flex items-center gap-3 mt-2 flex-wrap">
          <label :class="[$style.radioLabel, 'flex', 'items-center', 'gap-2']">
            <input type="radio" v-model="editVisibility" value="public"> 公開
          </label>
          <label :class="[$style.radioLabel, 'flex', 'items-center', 'gap-2']">
            <input type="radio" v-model="editVisibility" value="private"> 非公開
          </label>
          <label :class="[$style.radioLabel, 'flex', 'items-center', 'gap-2']">
            <input type="radio" v-model="editVisibility" value="passphrase"> 合言葉で保護
          </label>
          <input
            v-if="editVisibility === 'passphrase'"
            v-model="editPassphrase"
            :class="[$style.passphraseInput, 'form-input', 'form-input-mono']"
            type="text"
            placeholder="合言葉"
          >
          <Button.Root class="btn btn-primary" :disabled="visibilitySaving" @click="saveVisibility">
            <Button.Content>保存</Button.Content>
          </Button.Root>
        </div>
        <div v-if="editVisibility === 'public'" :class="['text-muted', $style.smallText, 'mt-1']">
          一度公開したファイルは非公開に戻せません。
        </div>
        <div v-if="visibilityError" :class="[$style.visibilityError, 'mt-1']">{{ visibilityError }}</div>
      </template>
    </div>

    <!-- 発行フォーム -->
    <div v-if="fileVisibility === 'public'" :class="[$style.sectionCard, 'card', 'mb-3']">
      <div :class="['text-muted', $style.smallText]">公開ファイルにはアクセストークンは不要です。</div>
    </div>
    <div v-else :class="[$style.sectionCard, 'card', 'mb-3']">
      <div :class="[$style.sectionHeading, 'text-muted', 'mb-2']">新しいトークンを発行</div>

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
          <div :class="['text-muted', $style.createdTokenLabel, 'mb-1']">ダウンロードURL（この画面を閉じると再表示できません）</div>
          <div class="flex items-center gap-2 flex-wrap">
            <code :class="$style.tokenUrl">{{ downloadUrl(createdToken.token) }}</code>
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
      <div :class="[$style.sectionHeading, 'text-muted', 'mb-2']">発行済みトークン</div>
      <div v-if="loading" :class="['text-muted', $style.smallText]">読み込み中...</div>
      <div v-else-if="listError" :class="$style.listError">{{ listError }}</div>
      <div v-else-if="tokens.length === 0" :class="['text-muted', $style.smallText]">トークンはありません</div>
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
                    …
                  </Popover.Activator>
                  <Popover.Content class="action-menu">
                    <Button.Root class="btn btn-ghost-danger w-full" :class="$style.menuItem" @click="openDeleteDialog(t.id)">
                      <Button.Content>削除</Button.Content>
                    </Button.Root>
                  </Popover.Content>
                </Popover.Root>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="deleteError" :class="[$style.deleteError, 'mt-2']">{{ deleteError }}</div>
    </div>

    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      title="トークンを削除"
      message="このアクセストークンを削除します。削除後は使用できなくなります。"
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

.radioLabel {
  cursor: pointer;
}

.passphraseInput {
  width: 200px;
}

.visibilityError {
  color: var(--color-danger);
  font-size: 0.8rem;
}

.sectionHeading {
  font-size: 0.875rem;
  font-weight: 600;
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
