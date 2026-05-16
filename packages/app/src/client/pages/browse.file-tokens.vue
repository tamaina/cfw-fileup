<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button } from '@vuetify/v0';
import ConfirmDialog from '@/components/confirm-dialog.vue';
import { authHeaders } from '@/store/auth';

const props = defineProps<{
	bucketName: string;
	filePath: string;
	fileIsPublic: boolean;
}>();
const emit = defineEmits<{
	(e: 'update:fileIsPublic', value: boolean): void;
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

const visibilityEditing = ref(false);
const editIsPublic = ref(true);
const editPassphrase = ref('');
const visibilitySaving = ref(false);
const visibilityError = ref('');

async function loadTokens(): Promise<void> {
	loading.value = true;
	listError.value = '';
	try {
		const res = await fetch('/api/file-tokens/list', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ bucketName: props.bucketName, filePath: props.filePath }),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({})) as { error?: string };
			listError.value = err.error ?? `取得失敗: ${res.status}`;
			return;
		}
		const data = await res.json() as { tokens: FileToken[] };
		tokens.value = data.tokens.sort((a, b) => b.createdAt - a.createdAt);
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
		const res = await fetch('/api/file-tokens/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({
				bucketName: props.bucketName,
				filePath: props.filePath,
				expiresIn,
			}),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({})) as { error?: string };
			createError.value = err.error ?? `発行失敗: ${res.status}`;
			return;
		}
		const data = await res.json() as { id: string; token: string; expiresAt: number | null };
		createdToken.value = data;
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
		const res = await fetch('/api/file-tokens/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ tokenId: deletingId.value }),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({})) as { error?: string };
			deleteError.value = err.error ?? `削除失敗: ${res.status}`;
			return;
		}
		tokens.value = tokens.value.filter((t) => t.id !== deletingId.value);
		if (createdToken.value?.id === deletingId.value) createdToken.value = null;
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

function startEditVisibility(): void {
	editIsPublic.value = props.fileIsPublic;
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
		emit('update:fileIsPublic', editIsPublic.value);
		visibilityEditing.value = false;
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
    <div class="card mb-3" style="padding: 12px 16px">
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

    <!-- 発行フォーム -->
    <div v-if="fileIsPublic" class="card mb-3" style="padding: 12px 16px">
      <div class="text-muted" style="font-size:0.875rem">公開ファイルにはアクセストークンは不要です。</div>
    </div>
    <div v-else class="card mb-3" style="padding: 12px 16px">
      <div class="text-muted mb-2" style="font-size:0.875rem; font-weight:600">新しいトークンを発行</div>

      <div class="flex items-center gap-3 flex-wrap">
        <select v-model="expiryMode" class="form-input" style="width:120px">
          <option value="unlimited">無制限</option>
          <option value="datetime">日時指定</option>
          <option value="duration">経過指定</option>
        </select>

        <!-- 日時指定 -->
        <template v-if="expiryMode === 'datetime'">
          <input v-model="datetimeDate" class="form-input" type="date" style="width:160px">
          <input v-model="datetimeTime" class="form-input" type="time" style="width:120px">
        </template>

        <!-- 経過指定 -->
        <template v-else-if="expiryMode === 'duration'">
          <input
            v-model.number="durationValue"
            class="form-input"
            type="number"
            min="1"
            style="width:80px"
          >
          <select v-model.number="durationUnit" class="form-input" style="width:100px">
            <option :value="60">分</option>
            <option :value="3600">時間</option>
            <option :value="86400">日</option>
          </select>
        </template>

        <Button.Root class="btn btn-primary btn-sm" :disabled="creating" @click="createToken">
          <Button.Content>発行</Button.Content>
        </Button.Root>
      </div>
      <div v-if="createError" class="mt-2" style="color:var(--color-danger); font-size:0.8rem">{{ createError }}</div>

      <!-- 発行後のトークン表示 -->
      <template v-if="createdToken">
        <div class="mt-3" style="background:var(--color-bg); border:1px solid var(--color-border); border-radius:6px; padding:10px 12px">
          <div class="text-muted mb-1" style="font-size:0.8rem">ダウンロードURL（この画面を閉じると再表示できません）</div>
          <div class="flex items-center gap-2 flex-wrap">
            <code style="font-size:0.8rem; word-break:break-all; flex:1">{{ downloadUrl(createdToken.token) }}</code>
            <Button.Root class="btn btn-secondary btn-sm" @click="copyUrl">
              <Button.Content>{{ copied ? 'コピー済み' : 'コピー' }}</Button.Content>
            </Button.Root>
          </div>
          <div class="mt-1" style="font-size:0.75rem; color:var(--color-muted)">
            有効期限: {{ formatDate(createdToken.expiresAt) }}
          </div>
        </div>
      </template>
    </div>

    <!-- トークン一覧 -->
    <div v-if="!fileIsPublic" class="card" style="padding: 12px 16px">
      <div class="text-muted mb-2" style="font-size:0.875rem; font-weight:600">発行済みトークン</div>
      <div v-if="loading" class="text-muted" style="font-size:0.875rem">読み込み中...</div>
      <div v-else-if="listError" style="color:var(--color-danger); font-size:0.875rem">{{ listError }}</div>
      <div v-else-if="tokens.length === 0" class="text-muted" style="font-size:0.875rem">トークンはありません</div>
      <table v-else class="table" style="width:100%; font-size:0.875rem">
        <thead>
          <tr>
            <th>ID</th>
            <th>発行日時</th>
            <th>有効期限</th>
            <th>状態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tokens" :key="t.id">
            <td>
              <code style="font-size:0.8rem">{{ t.id.slice(0, 12) }}...</code>
            </td>
            <td>{{ new Date(t.createdAt).toLocaleString() }}</td>
            <td>{{ formatDate(t.expiresAt) }}</td>
            <td>
              <span :class="isExpired(t.expiresAt) ? 'badge badge-muted' : 'badge badge-success'">
                {{ isExpired(t.expiresAt) ? '期限切れ' : '有効' }}
              </span>
            </td>
            <td>
              <Button.Root class="btn btn-danger btn-sm" @click="openDeleteDialog(t.id)">
                <Button.Content>削除</Button.Content>
              </Button.Root>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="deleteError" class="mt-2" style="color:var(--color-danger); font-size:0.8rem">{{ deleteError }}</div>
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
