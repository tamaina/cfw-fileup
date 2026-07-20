<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Button, Form } from '@vuetify/v0';
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { apiPost } from '@/utils/api';
import { authStore, clearAuth, fetchCurrentUser } from '@/store/auth';
import { mainRouter } from '@/router';
import InfiniteTableRow from '@/components/InfiniteTableRow.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import SensitiveActionAuth from '@/components/SensitiveActionAuth.vue';
import type { ApiReq } from '../../../shared/api';
import { useBackupCodeActions } from '@/composables/useBackupCodeActions';
import { listEncryptionKeys, deleteEncryptionKey, clearAllEncryptionKeys, exportEncryptionKeys, importEncryptionKeys, type KeyRecord, type EncryptionKeyExport } from '@/utils/encryption-key-store';
import NirA from '@/components/NirA.vue';

interface PasskeyItem {
	id: string;
	name: string | null;
	createdAt: number;
}

interface BackupCodeStatus {
	count: number;
	remaining: number;
}

type TokenItem = {
	id: string;
	createdAt: number;
	lastIpAddress: string | null;
	isCurrent: boolean;
	isRevoked: boolean;
};

const pageError = ref('');
const pageSuccess = ref('');

const passwordForm = reactive({ currentPassword: '', newPassword: '' });
const passwordLoading = ref(false);
const hasPassword = computed(() => authStore.user?.hasPassword ?? true);
const recentlyAuthenticated = computed(() => authStore.user?.recentlyAuthenticated ?? false);

const passkeys = ref<PasskeyItem[]>([]);
const passkeysLoading = ref(true);
const passkeyError = ref('');
const registerError = ref('');
const registering = ref(false);
const registerSuccess = ref('');
const newPasskeyName = ref('');

const backupCodeStatus = ref<BackupCodeStatus | null>(null);
const backupCodes = ref<string[]>([]);
const generatingCodes = ref(false);
const backupCodeError = ref('');
const showGenerateConfirm = ref(false);
const shouldWarnBackupCodes = computed(() =>
	passkeys.value.length > 0 && backupCodeStatus.value?.count === 0,
);
const { copied, copyBackupCodes, downloadBackupCodes } = useBackupCodeActions(
	backupCodes,
	formatBackupCode,
	(message) => { backupCodeError.value = message; },
);

const tokens = ref<TokenItem[]>([]);
const tokensLoading = ref(true);
const loadingMoreTokens = ref(false);
const tokenError = ref('');
const revokingTokens = ref(false);
const nextTokenCursor = ref<string | null>(null);
const hasMoreTokens = ref(false);

// --- セキュリティー設定のタブ ---
const activeTab = ref<'passkey' | 'password' | 'tokens' | 'encryption'>('passkey');

// --- E2E暗号化鍵管理 ---
type EncryptionKeyItem = KeyRecord;
const encryptionKeys = ref<EncryptionKeyItem[]>([]);
const encryptionKeysLoading = ref(true);
const encryptionKeyError = ref('');
const clearingEncryptionKeys = ref(false);
const showClearEncryptionKeysConfirm = ref(false);
const exportingEncryptionKeys = ref(false);
const importingEncryptionKeys = ref(false);
const importResult = ref('');
const importFileInput = ref<HTMLInputElement | null>(null);

/**
 * 復号キーに対応するファイルの閲覧ページURLを返す。
 * 位置情報（bucketName/path）が記録されていない古いレコードは null を返す。
 */
function encryptionKeyLink(ek: EncryptionKeyItem): string | null {
	if (!ek.bucketName || !ek.path) return null;
	return `/v/${ek.bucketName}/${ek.path}`;
}

async function loadEncryptionKeys(): Promise<void> {
	encryptionKeysLoading.value = true;
	encryptionKeyError.value = '';
	try {
		encryptionKeys.value = await listEncryptionKeys();
	} catch (e) {
		encryptionKeyError.value = String(e);
	} finally {
		encryptionKeysLoading.value = false;
	}
}

async function removeEncryptionKey(fileId: string): Promise<void> {
	try {
		await deleteEncryptionKey(fileId);
		encryptionKeys.value = encryptionKeys.value.filter(k => k.fileId !== fileId);
	} catch (e) {
		encryptionKeyError.value = String(e);
	}
}

async function removeAllEncryptionKeys(): Promise<void> {
	clearingEncryptionKeys.value = true;
	try {
		await clearAllEncryptionKeys();
		encryptionKeys.value = [];
	} catch (e) {
		encryptionKeyError.value = String(e);
	} finally {
		clearingEncryptionKeys.value = false;
	}
}

async function handleExportEncryptionKeys(): Promise<void> {
	exportingEncryptionKeys.value = true;
	encryptionKeyError.value = '';
	try {
		const data = await exportEncryptionKeys();
		const json = JSON.stringify(data, null, 2);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `cfw-fileup-encryption-keys-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 100);
	} catch (e) {
		encryptionKeyError.value = String(e);
	} finally {
		exportingEncryptionKeys.value = false;
	}
}

function triggerImportEncryptionKeys(): void {
	importFileInput.value?.click();
}

async function handleImportEncryptionKeysFile(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	// 同じファイルを再選択できるようにリセット
	input.value = '';
	if (!file) return;

	importingEncryptionKeys.value = true;
	encryptionKeyError.value = '';
	importResult.value = '';
	try {
		const text = await file.text();
		let data: EncryptionKeyExport;
		try {
			data = JSON.parse(text) as EncryptionKeyExport;
		} catch {
			throw new Error('JSONファイルの解析に失敗しました');
		}
		const result = await importEncryptionKeys(data);
		importResult.value = `${result.imported}件をインポートしました` + (result.skipped > 0 ? `（${result.skipped}件は既存のためスキップ）` : '');
		await loadEncryptionKeys();
	} catch (e) {
		encryptionKeyError.value = String(e);
	} finally {
		importingEncryptionKeys.value = false;
	}
}

async function saveInitialPassword(): Promise<void> {
	pageError.value = '';
	pageSuccess.value = '';
	passwordLoading.value = true;
	try {
		const result = await apiPost('/api/account/update', { newPassword: passwordForm.newPassword });
		if (!result.ok) {
			pageError.value = result.data.message || 'パスワード設定に失敗しました';
			return;
		}
		passwordForm.newPassword = '';
		await fetchCurrentUser();
		pageSuccess.value = 'パスワードを設定しました';
	} catch (e) {
		pageError.value = String(e);
	} finally {
		passwordLoading.value = false;
	}
}

async function savePassword(): Promise<void> {
	pageError.value = '';
	pageSuccess.value = '';
	passwordLoading.value = true;
	try {
		const result = await apiPost('/api/account/update', {
			currentPassword: passwordForm.currentPassword,
			newPassword: passwordForm.newPassword,
		});
		if (!result.ok) {
			pageError.value = result.data.message || 'パスワード変更に失敗しました';
			return;
		}
		passwordForm.currentPassword = '';
		passwordForm.newPassword = '';
		await fetchCurrentUser();
		pageSuccess.value = 'パスワードを変更しました';
	} catch (e) {
		pageError.value = String(e);
	} finally {
		passwordLoading.value = false;
	}
}

async function loadPasskeys(): Promise<void> {
	passkeysLoading.value = true;
	passkeyError.value = '';
	try {
		const result = await apiPost('/api/passkey/list');
		if (!result.ok) {
			passkeyError.value = result.data.message || 'パスキー一覧の取得に失敗しました';
			return;
		}
		passkeys.value = result.data;
	} catch (e) {
		passkeyError.value = String(e);
	} finally {
		passkeysLoading.value = false;
	}
}

async function loadBackupCodeStatus(): Promise<void> {
	try {
		const result = await apiPost('/api/passkey/backup-codes/status');
		if (result.ok) backupCodeStatus.value = result.data;
	} catch {
		// ignore
	}
}

async function registerPasskey(): Promise<void> {
	registerError.value = '';
	registerSuccess.value = '';
	registering.value = true;
	try {
		const beginResult = await apiPost('/api/passkey/register/begin');
		if (!beginResult.ok) {
			registerError.value = beginResult.data.message || '登録の開始に失敗しました';
			return;
		}
		const { challengeId, options } = beginResult.data;

		let credential;
		try {
			credential = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
		} catch (e) {
			registerError.value = `パスキーの作成がキャンセルされました: ${String(e)}`;
			return;
		}

		const finishResult = await apiPost('/api/passkey/register/finish', {
			challengeId,
			credential: credential as unknown as ApiReq<'/api/passkey/register/finish'>['credential'],
			name: newPasskeyName.value.trim() || undefined,
		});
		if (!finishResult.ok) {
			registerError.value = finishResult.data.message || '登録の完了に失敗しました';
			return;
		}

		registerSuccess.value = 'パスキーを登録しました';
		newPasskeyName.value = '';
		await Promise.all([loadPasskeys(), loadBackupCodeStatus()]);
	} catch (e) {
		registerError.value = String(e);
	} finally {
		registering.value = false;
	}
}

async function deletePasskey(id: string): Promise<void> {
	if (!window.confirm('このパスキーを削除しますか？')) return;
	try {
		const result = await apiPost('/api/passkey/delete', { passkeyId: id });
		if (!result.ok) {
			passkeyError.value = result.data.message || 'パスキーの削除に失敗しました';
			return;
		}
		await Promise.all([loadPasskeys(), loadBackupCodeStatus()]);
	} catch (e) {
		passkeyError.value = String(e);
	}
}

async function generateBackupCodes(): Promise<void> {
	if (passkeys.value.length === 0) {
		backupCodeError.value = 'バックアップコードを生成するには、先にパスキーを登録してください';
		return;
	}
	showGenerateConfirm.value = false;
	backupCodeError.value = '';
	backupCodes.value = [];
	generatingCodes.value = true;
	try {
		const result = await apiPost('/api/passkey/backup-codes/generate');
		if (!result.ok) {
			backupCodeError.value = result.data.message || 'バックアップコードの生成に失敗しました';
			return;
		}
		backupCodes.value = result.data.codes;
		await loadBackupCodeStatus();
	} catch (e) {
		backupCodeError.value = String(e);
	} finally {
		generatingCodes.value = false;
	}
}

async function loadTokens(cursor: string | null = null): Promise<void> {
	const isMore = cursor !== null;
	if (isMore) {
		loadingMoreTokens.value = true;
	} else {
		tokensLoading.value = true;
	}
	tokenError.value = '';
	try {
		const result = await apiPost('/api/account/tokens', { limit: 50, cursor });
		if (!result.ok) {
			tokenError.value = result.data.message || 'アクセストークン履歴の取得に失敗しました';
			return;
		}
		tokens.value = cursor ? [...tokens.value, ...result.data.items] : result.data.items;
		nextTokenCursor.value = result.data.nextCursor;
		hasMoreTokens.value = result.data.hasMore;
	} catch (e) {
		tokenError.value = String(e);
	} finally {
		if (isMore) {
			loadingMoreTokens.value = false;
		} else {
			tokensLoading.value = false;
		}
	}
}

async function revokeAllTokens(): Promise<void> {
	if (!window.confirm('すべてのアクセストークンを失効します。現在のセッションもログアウトされます。')) return;
	revokingTokens.value = true;
	tokenError.value = '';
	try {
		const result = await apiPost('/api/account/tokens/revoke-all');
		if (!result.ok) {
			tokenError.value = result.data.message || 'アクセストークンの失効に失敗しました';
			return;
		}
		clearAuth();
		mainRouter.pushByPath('/signin');
	} catch (e) {
		tokenError.value = String(e);
	} finally {
		revokingTokens.value = false;
	}
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString();
}

function formatBackupCode(code: string): string {
	return `${code.slice(0, 5)}-${code.slice(5)}`;
}

onMounted(async () => {
	await fetchCurrentUser();
	await Promise.all([loadPasskeys(), loadBackupCodeStatus(), loadTokens(), loadEncryptionKeys()]);
});
</script>

<template>
  <div :class="$style.root">
    <div class="section-header">
      <h2 class="section-title">セキュリティー</h2>
    </div>

    <div v-if="pageSuccess" class="alert alert-success mb-4">{{ pageSuccess }}</div>
    <div v-if="pageError" class="alert alert-error mb-4">{{ pageError }}</div>
    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>

    <template v-else>
      <SensitiveActionAuth
        :class="['card', $style.card, 'mb-4']"
        :show-password-fallback="false"
        description="パスワード未設定のアカウントでパスワードを設定するには、先にパスキーで本人確認します。"
        @success="(message: string) => { pageError = ''; pageSuccess = message; }"
        @error="(message: string) => { pageSuccess = ''; pageError = message; }"
      />

      <div class="tab-bar mb-4">
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'passkey' }" @click="activeTab = 'passkey'">パスキー</button>
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'password' }" @click="activeTab = 'password'">パスワード</button>
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'tokens' }" @click="activeTab = 'tokens'">アクセストークン</button>
        <button type="button" class="tab-btn" :class="{ 'tab-btn-active': activeTab === 'encryption' }" @click="activeTab = 'encryption'">E2E暗号化キー</button>
      </div>

      <section v-if="activeTab === 'password'" :class="$style.section">
        <div :class="['card', $style.card]">
          <div :class="$style.serviceHeader">
            <div>
              <h3 :class="$style.serviceTitle">パスワード</h3>
              <p :class="$style.serviceDescription">
                {{ hasPassword ? 'ログインとバックアップコード認証に使うパスワードを変更します。' : 'バックアップコードでログインするときに使います。' }}
              </p>
            </div>
            <span :class="['badge', hasPassword ? 'badge-success' : 'badge-info']">{{ hasPassword ? '設定済み' : '未設定' }}</span>
          </div>
          <Form v-if="hasPassword" :class="$style.form" @submit="savePassword">
            <div :class="$style.formGroup">
              <label class="form-label" for="current-password">現在のパスワード</label>
              <input id="current-password" v-model="passwordForm.currentPassword" class="form-input" type="password" autocomplete="current-password" required>
            </div>
            <div :class="$style.formGroup">
              <label class="form-label" for="new-password">新しいパスワード</label>
              <input id="new-password" v-model="passwordForm.newPassword" class="form-input" type="password" autocomplete="new-password" minlength="8" required>
            </div>
            <button class="btn btn-primary" type="submit" :disabled="passwordLoading || !passwordForm.currentPassword || passwordForm.newPassword.length < 8">
              {{ passwordLoading ? '処理中...' : 'パスワードを変更' }}
            </button>
          </Form>
          <Form v-else :class="$style.form" @submit="saveInitialPassword">
            <div :class="$style.formGroup">
              <label class="form-label" for="initial-new-password">新しいパスワード</label>
              <input id="initial-new-password" v-model="passwordForm.newPassword" class="form-input" type="password" autocomplete="new-password" minlength="8" required>
            </div>
            <div v-if="!recentlyAuthenticated" class="alert alert-info">
              パスワードを設定するにはパスキーで再認証してください。
            </div>
            <button class="btn btn-primary" type="submit" :disabled="passwordLoading || !recentlyAuthenticated || passwordForm.newPassword.length < 8">
              {{ passwordLoading ? '処理中...' : 'パスワードを設定' }}
            </button>
          </Form>
        </div>
      </section>

      <section v-if="activeTab === 'passkey'" :class="$style.section">
        <h3 :class="$style.sectionTitle">パスキー</h3>

        <div :class="['card', $style.card, shouldWarnBackupCodes && $style.backupCardWarning]">
          <div :class="$style.serviceHeader">
            <div>
              <h4 :class="$style.serviceTitle">バックアップコード</h4>
              <p :class="$style.serviceDescription">新しいコードを生成すると、古いコードはすべて無効になります。</p>
            </div>
            <span v-if="backupCodeStatus" class="badge badge-info">
              {{ backupCodeStatus.count === 0 ? '未生成' : `${backupCodeStatus.remaining} / ${backupCodeStatus.count}` }}
            </span>
          </div>
          <div v-if="passkeys.length === 0" :class="$style.mutedText">
            バックアップコードを生成するには、先にパスキーを登録してください。
          </div>
          <div v-else-if="backupCodes.length === 0">
            <Button.Root
              :class="shouldWarnBackupCodes ? ['btn', 'btn-danger', $style.backupNeedsBtn] : ['btn', 'btn-secondary']"
              :loading="generatingCodes"
              @click="backupCodeStatus && backupCodeStatus.count > 0 ? showGenerateConfirm = true : generateBackupCodes()"
            >
              <Button.Loading>生成中...</Button.Loading>
              <Button.Content>バックアップコードを生成</Button.Content>
            </Button.Root>
          </div>
          <div v-if="shouldWarnBackupCodes" class="alert alert-warning">
            パスキーをなくしたときにログインできなくなる可能性があります。バックアップコードを生成して安全な場所に保管してください。
          </div>
          <div v-if="backupCodeError" :class="['alert', 'alert-error', $style.inlineAlert]">
            {{ backupCodeError }}
          </div>
          <div v-if="backupCodes.length > 0" :class="$style.backupCodesSection">
            <p :class="$style.backupCodesWarning">このコードは今後表示されません。必ず安全な場所に保存してください。</p>
            <div :class="$style.backupCodesGrid">
              <div v-for="code in backupCodes" :key="code" :class="$style.backupCode">
                {{ formatBackupCode(code) }}
              </div>
            </div>
            <div :class="$style.actions">
              <Button.Root class="btn btn-secondary" @click="copyBackupCodes">
                <Button.Content>{{ copied ? 'コピーしました！' : 'すべてコピー' }}</Button.Content>
              </Button.Root>
              <Button.Root class="btn btn-primary" @click="downloadBackupCodes">
                <Button.Content>テキストファイルとして保存</Button.Content>
              </Button.Root>
            </div>
          </div>
        </div>

        <div :class="['card', $style.card]">
          <h4 :class="$style.serviceTitle">新しいパスキーを登録</h4>
          <Form :class="$style.form" @submit="registerPasskey">
            <div :class="$style.formGroup">
              <label class="form-label" for="passkey-name">パスキー名（任意）</label>
              <input
                id="passkey-name"
                v-model="newPasskeyName"
                class="form-input"
                type="text"
                placeholder="例: iPhoneのFace ID"
                maxlength="64"
              >
              <div class="form-hint">このデバイスや認証器を識別するための名前</div>
            </div>
            <button class="btn btn-primary" type="submit" :disabled="registering">
              {{ registering ? '登録中...' : '登録' }}
            </button>
          </Form>
          <div v-if="registerSuccess" :class="['alert', 'alert-success', $style.inlineAlert]">
            {{ registerSuccess }}
          </div>
          <div v-if="registerError" :class="['alert', 'alert-error', $style.inlineAlert]">
            {{ registerError }}
          </div>
        </div>

        <div :class="['card', $style.card]">
          <h4 :class="$style.serviceTitle">登録済みパスキー</h4>
          <div v-if="passkeysLoading" :class="$style.mutedText">読み込み中...</div>
          <div v-else-if="passkeyError" class="alert alert-error">{{ passkeyError }}</div>
          <div v-else-if="passkeys.length === 0" :class="$style.mutedText">登録済みのパスキーはありません。</div>
          <div v-else class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>登録日時</th>
                  <th class="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="pk in passkeys" :key="pk.id">
                  <td :class="$style.passkeyName">{{ pk.name ?? '（名前なし）' }}</td>
                  <td class="col-muted">{{ formatDate(pk.createdAt) }}</td>
                  <td class="col-actions">
                    <Button.Root :class="['btn', 'btn-ghost', $style.deleteButton]" @click="deletePasskey(pk.id)">
                      <Button.Content>削除</Button.Content>
                    </Button.Root>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="activeTab === 'tokens'" :class="$style.section">
        <div :class="$style.tokenHeader">
          <div>
            <h3 :class="$style.sectionTitle">アクセストークン</h3>
            <p :class="$style.sectionDescription">ログイン履歴と、各トークンが最後に使われたIPを確認できます。</p>
          </div>
          <Button.Root class="btn btn-danger" :loading="revokingTokens" @click="revokeAllTokens">
            <Button.Loading>失効中...</Button.Loading>
            <Button.Content>すべて失効</Button.Content>
          </Button.Root>
        </div>

        <div v-if="tokenError" class="alert alert-error">{{ tokenError }}</div>
        <div v-if="tokensLoading" class="page-loading">
          <span class="spinner" />
          読み込み中...
        </div>
        <div v-else class="card">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>トークンID</th>
                  <th>発行日時</th>
                  <th>最後のIP</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="token in tokens" :key="token.id">
                  <td>{{ token.id }}</td>
                  <td>{{ formatDate(token.createdAt) }}</td>
                  <td>{{ token.lastIpAddress ?? '未記録' }}</td>
                  <td>
                    <span v-if="token.isRevoked" class="badge badge-danger">失効済み</span>
                    <span v-else-if="token.isCurrent" class="badge badge-info">現在</span>
                    <span v-else class="badge badge-success">有効</span>
                  </td>
                </tr>
                <tr v-if="tokens.length === 0">
                  <td colspan="4">アクセストークンはありません。</td>
                </tr>
                <InfiniteTableRow
                  v-if="hasMoreTokens || loadingMoreTokens"
                  :colspan="4"
                  :has-more="hasMoreTokens"
                  :loading="loadingMoreTokens"
                  @load-more="loadTokens(nextTokenCursor)"
                />
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="activeTab === 'encryption'" :class="$style.section">
        <div :class="$style.tokenHeader">
          <div>
            <h3 :class="$style.sectionTitle">E2E暗号化キー</h3>
            <p :class="$style.sectionDescription">
              このブラウザに保存されているエンドツーエンド暗号化の復号キーです。削除すると、対応するファイルをこのブラウザで復号できなくなります。
            </p>
          </div>
          <div :class="$style.encKeyActions">
            <Button.Root
              class="btn btn-secondary"
              :loading="exportingEncryptionKeys"
              :disabled="encryptionKeys.length === 0"
              @click="handleExportEncryptionKeys"
            >
              <Button.Loading>エクスポート中...</Button.Loading>
              <Button.Content>エクスポート</Button.Content>
            </Button.Root>
            <Button.Root
              class="btn btn-secondary"
              :loading="importingEncryptionKeys"
              @click="triggerImportEncryptionKeys"
            >
              <Button.Loading>インポート中...</Button.Loading>
              <Button.Content>インポート</Button.Content>
            </Button.Root>
            <input
              ref="importFileInput"
              type="file"
              accept=".json,application/json"
              :class="$style.hiddenFileInput"
              @change="handleImportEncryptionKeysFile"
            >
            <Button.Root
              v-if="encryptionKeys.length > 0"
              class="btn btn-danger"
              :loading="clearingEncryptionKeys"
              @click="showClearEncryptionKeysConfirm = true"
            >
              <Button.Loading>削除中...</Button.Loading>
              <Button.Content>すべて削除</Button.Content>
            </Button.Root>
          </div>
        </div>

        <div v-if="encryptionKeyError" class="alert alert-error">{{ encryptionKeyError }}</div>
        <div v-if="importResult" class="alert alert-success">{{ importResult }}</div>
        <div v-if="encryptionKeysLoading" :class="$style.mutedText">読み込み中...</div>
        <div v-else-if="encryptionKeys.length === 0" :class="$style.mutedText">保存されている復号キーはありません。</div>
        <div v-else class="card">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>ファイルID</th>
                  <th>ファイル</th>
                  <th>キー（先頭）</th>
                  <th>保存日時</th>
                  <th class="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="ek in encryptionKeys" :key="ek.fileId">
                  <td :class="$style.encKeyId">{{ ek.fileId }}</td>
                  <td>
                    <NirA v-if="encryptionKeyLink(ek)" :to="encryptionKeyLink(ek)!" :class="$style.encKeyLink" :title="ek.path">
                      {{ ek.path }}
                    </NirA>
                    <span v-else :class="$style.encKeyNoLink">リンクなし</span>
                  </td>
                  <td :class="$style.encKeyPreview" :title="ek.keyMultibase">{{ ek.keyMultibase.slice(0, 16) }}…</td>
                  <td class="col-muted">{{ formatDate(ek.createdAt) }}</td>
                  <td class="col-actions">
                    <Button.Root :class="['btn', 'btn-ghost', $style.deleteButton]" @click="removeEncryptionKey(ek.fileId)">
                      <Button.Content>削除</Button.Content>
                    </Button.Root>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </template>

    <ConfirmDialog
      v-model:open="showGenerateConfirm"
      title="バックアップコードを再生成"
      message="既存のコードが無効になります。続けますか？"
      confirm-label="生成する"
      :danger="true"
      @confirm="generateBackupCodes"
    />
    <ConfirmDialog
      v-model:open="showClearEncryptionKeysConfirm"
      title="復号キーをすべて削除"
      message="このブラウザに保存されているすべての復号キーが削除されます。削除すると、対応する暗号化ファイルをこのブラウザで復号できなくなります。続けますか？"
      confirm-label="すべて削除"
      :danger="true"
      @confirm="removeAllEncryptionKeys"
    />
  </div>
</template>

<style module lang="scss">
.root {
  max-width: 960px;
}

.section {
  display: grid;
  // minmax(0, 1fr) にしないと、グリッドアイテムの min-width: auto によって
  // テーブルの固有幅がカードを押し広げ、ページ全体が横スクロールになる
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  margin-bottom: 28px;
}

.sectionTitle {
  margin: 0;
  font-size: 1.125rem;
}

.sectionDescription {
  margin: 6px 0 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.card {
  padding: 16px;
}

.serviceHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.serviceTitle {
  margin: 0 0 6px;
  font-size: 1rem;
}

.serviceDescription {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.form {
  display: grid;
  gap: 12px;
}

.formGroup {
  display: grid;
  gap: 6px;
}

.inlineAlert {
  margin-top: 12px;
}

.mutedText {
  color: var(--color-text-muted);
  font-size: 0.9rem;
}

.backupCardWarning {
  border-color: #f59e0b;
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.18), var(--shadow-sm);
}

.backupCodesSection {
  margin-top: 16px;
}

.backupCodesWarning {
  margin-bottom: 8px;
  color: var(--color-warning);
  font-size: 0.875rem;
  font-weight: 600;
}

.backupCodesGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 16px;
  border-radius: 8px;
  background: var(--color-surface-raised);
  font-family: monospace;
}

.backupCode {
  font-size: 1rem;
  letter-spacing: 0.05em;
}

.backupNeedsBtn {
  margin-bottom: 12px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.passkeyName {
  font-weight: 500;
}

.deleteButton {
  color: var(--color-danger);
  font-size: 0.8rem;
}

.tokenHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.encKeyId {
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
}

.encKeyPreview {
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.encKeyLink {
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
  color: var(--color-primary);
  text-decoration: none;
  word-break: break-all;

  &:hover {
    text-decoration: underline;
  }
}

.encKeyNoLink {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.encKeyActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.hiddenFileInput {
  display: none;
}

@media (max-width: 640px) {
  .serviceHeader,
  .tokenHeader {
    flex-direction: column;
  }

  .backupCodesGrid {
    grid-template-columns: 1fr;
  }
}
</style>
