<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button, Form } from '@vuetify/v0';
import {
	startRegistration,
} from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { apiPost } from '../utils/api';
import type { ApiReq } from '../../shared/api';

interface PasskeyItem {
	id: string;
	name: string | null;
	createdAt: number;
}

interface BackupCodeStatus {
	count: number;
	remaining: number;
}

const passkeys = ref<PasskeyItem[]>([]);
const loading = ref(true);
const error = ref('');
const registerError = ref('');
const registering = ref(false);
const registerSuccess = ref('');
const newPasskeyName = ref('');

const backupCodeStatus = ref<BackupCodeStatus | null>(null);
const backupCodes = ref<string[]>([]);
const generatingCodes = ref(false);
const backupCodeError = ref('');
const showGenerateConfirm = ref(false);

async function loadPasskeys(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/passkey/list');
		if (!result.ok) {
			error.value = result.data.error || 'パスキー一覧の取得に失敗しました';
			return;
		}
		passkeys.value = result.data;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function loadBackupCodeStatus(): Promise<void> {
	try {
		const result = await apiPost('/api/passkey/backup-codes/status');
		if (result.ok) {
			backupCodeStatus.value = result.data;
		}
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
			registerError.value = beginResult.data.error || '登録の開始に失敗しました';
			return;
		}
		const { challengeId, options } = beginResult.data;

		let credential;
		try {
      // このunknownは仕方がない
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
			registerError.value = finishResult.data.error || '登録の完了に失敗しました';
			return;
		}

		registerSuccess.value = 'パスキーを登録しました';
		newPasskeyName.value = '';
		await loadPasskeys();
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
			error.value = result.data.error || 'パスキーの削除に失敗しました';
			return;
		}
		await loadPasskeys();
	} catch (e) {
		error.value = String(e);
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
			backupCodeError.value = result.data.error || 'バックアップコードの生成に失敗しました';
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

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString();
}

function formatBackupCode(code: string): string {
	return `${code.slice(0, 5)}-${code.slice(5)}`;
}

onMounted(async () => {
	await Promise.all([loadPasskeys(), loadBackupCodeStatus()]);
});
</script>

<template>
  <div :class="$style.root">
    <h2 :class="$style.title">パスキー管理</h2>

    <p :class="$style.description">
      パスキー（FIDO2 / WebAuthn）を登録すると、パスワード不要でサインインできます。
    </p>

    <!-- Register section -->
    <div :class="['card', $style.registerCard]">
      <h3 :class="$style.sectionTitle">新しいパスキーを登録</h3>
      <Form @submit="registerPasskey">
        <div :class="['form-group', $style.formGroup]">
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
        <div :class="$style.registerActions">
          <Button.Root
            class="btn btn-primary"
            type="submit"
            :loading="registering"
          >
            <Button.Loading>登録中...</Button.Loading>
            <Button.Content>登録</Button.Content>
          </Button.Root>
        </div>
      </Form>
      <div v-if="registerSuccess" :class="['alert', 'alert-success', $style.inlineAlert]">
        {{ registerSuccess }}
      </div>
      <div v-if="registerError" :class="['alert', 'alert-error', $style.inlineAlert]">
        {{ registerError }}
      </div>
    </div>

    <!-- Passkey list -->
    <div :class="['card', $style.passkeyCard]">
      <h3 :class="$style.sectionTitle">登録済みパスキー</h3>
      <div v-if="loading" :class="$style.mutedText">読み込み中...</div>
      <div v-else-if="error" class="alert alert-error">{{ error }}</div>
      <div v-else-if="passkeys.length === 0" :class="$style.emptyText">
        登録済みのパスキーはありません。
      </div>
      <div v-else :class="$style.passkeyList">
        <div
          v-for="pk in passkeys"
          :key="pk.id"
          :class="$style.passkeyItem"
        >
          <div>
            <div :class="$style.passkeyName">
              {{ pk.name ?? '（名前なし）' }}
            </div>
            <div :class="$style.passkeyMeta">
              登録日時: {{ formatDate(pk.createdAt) }}
            </div>
          </div>
          <Button.Root
            :class="['btn', 'btn-ghost', $style.deleteButton]"
            @click="deletePasskey(pk.id)"
          >
            <Button.Content>削除</Button.Content>
          </Button.Root>
        </div>
      </div>
    </div>

    <!-- Backup codes section -->
    <div :class="['card', $style.backupCard]">
      <h3 :class="$style.backupTitle">バックアップコード</h3>
      <p :class="$style.backupDescription">
        パスキーが使えないときにログインできるコードです。安全な場所に保管してください。
        新しいコードを生成すると、古いコードはすべて無効になります。
      </p>
      <div v-if="backupCodeStatus" :class="$style.backupStatus">
        <span v-if="backupCodeStatus.count === 0" :class="$style.mutedText">
          バックアップコードが生成されていません
        </span>
        <span v-else>
          残り <strong>{{ backupCodeStatus.remaining }}</strong> / {{ backupCodeStatus.count }} コード
        </span>
      </div>

      <div v-if="passkeys.length === 0" :class="$style.mutedText">
        バックアップコードを生成するには、先にパスキーを登録してください。
      </div>
      <div v-else-if="!showGenerateConfirm">
        <Button.Root
          class="btn btn-secondary"
          :loading="generatingCodes"
          @click="backupCodeStatus && backupCodeStatus.count > 0 ? showGenerateConfirm = true : generateBackupCodes()"
        >
          <Button.Loading>生成中...</Button.Loading>
          <Button.Content>バックアップコードを生成</Button.Content>
        </Button.Root>
      </div>
      <div v-else :class="$style.confirmRow">
        <span :class="$style.warningText">既存のコードが無効になります。続けますか？</span>
        <Button.Root class="btn btn-danger btn-sm" @click="generateBackupCodes">
          <Button.Content>生成する</Button.Content>
        </Button.Root>
        <Button.Root class="btn btn-ghost btn-sm" @click="showGenerateConfirm = false">
          <Button.Content>キャンセル</Button.Content>
        </Button.Root>
      </div>

      <div v-if="backupCodeError" :class="['alert', 'alert-error', $style.inlineAlert]">
        {{ backupCodeError }}
      </div>

      <div v-if="backupCodes.length > 0" :class="$style.backupCodesSection">
        <p :class="$style.backupCodesWarning">
          ⚠️ このコードは今後表示されません。必ず保存してください。
        </p>
        <div :class="$style.backupCodesGrid">
          <div
            v-for="code in backupCodes"
            :key="code"
            :class="$style.backupCode"
          >
            {{ formatBackupCode(code) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style module lang="scss">
.root {
  max-width: 640px;
  margin: 40px auto;
  padding: 0 16px;
}

.title {
  margin-bottom: 24px;
}

.description {
  margin-bottom: 24px;
  color: var(--color-text-muted);
  font-size: 0.9rem;
}

.registerCard {
  padding: 16px;
  margin-bottom: 24px;
}

.sectionTitle {
  margin-bottom: 12px;
  font-size: 1rem;
}

.formGroup {
  margin-bottom: 12px;
}

.registerActions {
  display: flex;
  justify-content: flex-end;
}

.inlineAlert {
  margin-top: 12px;
}

.mutedText {
  color: var(--color-text-muted);
}

.emptyText {
  color: var(--color-text-muted);
  font-size: 0.9rem;
}

.passkeyCard {
  padding: 16px;
}

.passkeyList {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.passkeyItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--color-border);
}

.passkeyItem:first-child {
  padding-top: 0;
  border-top: none;
}

.passkeyName {
  font-weight: 500;
}

.passkeyMeta {
  margin-top: 4px;
  color: var(--color-text-subtle);
  font-size: 0.8rem;
}

.deleteButton {
  color: var(--color-danger);
  font-size: 0.8rem;
}

.backupCard {
  padding: 16px;
  margin-top: 32px;
}

.backupTitle {
  margin-bottom: 8px;
  font-size: 1rem;
}

.backupDescription {
  margin-bottom: 12px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.backupStatus {
  margin-bottom: 12px;
  font-size: 0.875rem;
}

.confirmRow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.warningText {
  color: var(--color-warning);
  font-size: 0.875rem;
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
</style>
