<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button } from '@vuetify/v0';
import {
	startRegistration,
} from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { authHeaders } from '../store/auth';

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
		const res = await fetch('/api/passkey/list', {
			headers: authHeaders(),
		});
		if (!res.ok) {
			const data = (await res.json()) as { error?: string };
			error.value = data.error ?? 'パスキー一覧の取得に失敗しました';
			return;
		}
		passkeys.value = (await res.json()) as PasskeyItem[];
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function loadBackupCodeStatus(): Promise<void> {
	try {
		const res = await fetch('/api/passkey/backup-codes/status', {
			headers: authHeaders(),
		});
		if (res.ok) {
			backupCodeStatus.value = (await res.json()) as BackupCodeStatus;
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
		const beginRes = await fetch('/api/passkey/register/begin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
		});
		if (!beginRes.ok) {
			const data = (await beginRes.json()) as { error?: string };
			registerError.value = data.error ?? '登録の開始に失敗しました';
			return;
		}
		const { challengeId, options } = (await beginRes.json()) as {
			challengeId: string;
			options: PublicKeyCredentialCreationOptionsJSON;
		};

		let credential;
		try {
			credential = await startRegistration({ optionsJSON: options });
		} catch (e) {
			registerError.value = `パスキーの作成がキャンセルされました: ${String(e)}`;
			return;
		}

		const finishRes = await fetch('/api/passkey/register/finish', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ challengeId, credential, name: newPasskeyName.value.trim() || undefined }),
		});
		if (!finishRes.ok) {
			const data = (await finishRes.json()) as { error?: string };
			registerError.value = data.error ?? '登録の完了に失敗しました';
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
		const res = await fetch('/api/passkey/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ passkeyId: id }),
		});
		if (!res.ok) {
			const data = (await res.json()) as { error?: string };
			error.value = data.error ?? 'パスキーの削除に失敗しました';
			return;
		}
		await loadPasskeys();
	} catch (e) {
		error.value = String(e);
	}
}

async function generateBackupCodes(): Promise<void> {
	showGenerateConfirm.value = false;
	backupCodeError.value = '';
	backupCodes.value = [];
	generatingCodes.value = true;
	try {
		const res = await fetch('/api/passkey/backup-codes/generate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
		});
		if (!res.ok) {
			const data = (await res.json()) as { error?: string };
			backupCodeError.value = data.error ?? 'バックアップコードの生成に失敗しました';
			return;
		}
		const data = (await res.json()) as { codes: string[] };
		backupCodes.value = data.codes;
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
  <div style="max-width: 640px; margin: 40px auto; padding: 0 16px">
    <h2 style="margin-bottom: 24px">パスキー管理</h2>

    <p style="margin-bottom: 24px; color: var(--color-text-muted); font-size: 0.9rem">
      パスキー（FIDO2 / WebAuthn）を登録すると、パスワード不要でサインインできます。
    </p>

    <!-- Register section -->
    <div class="card" style="padding: 16px; margin-bottom: 24px">
      <h3 style="margin-bottom: 12px; font-size: 1rem">新しいパスキーを登録</h3>
      <div class="form-group" style="margin-bottom: 12px">
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
      <Button.Root
        class="btn btn-primary"
        :loading="registering"
        @click="registerPasskey"
      >
        <Button.Loading>登録中...</Button.Loading>
        <Button.Content>登録</Button.Content>
      </Button.Root>
      <div v-if="registerSuccess" class="alert alert-success" style="margin-top: 12px">
        {{ registerSuccess }}
      </div>
      <div v-if="registerError" class="alert alert-error" style="margin-top: 12px">
        {{ registerError }}
      </div>
    </div>

    <!-- Passkey list -->
    <div v-if="loading" style="color: var(--color-text-muted)">読み込み中...</div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <div v-else>
      <h3 style="margin-bottom: 12px; font-size: 1rem">登録済みパスキー</h3>
      <div v-if="passkeys.length === 0" style="color: var(--color-text-muted); font-size: 0.9rem; margin-bottom: 24px">
        登録済みのパスキーはありません。
      </div>
      <div
        v-for="pk in passkeys"
        :key="pk.id"
        class="card"
        style="margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; padding: 12px 16px"
      >
        <div>
          <div style="font-weight: 500">
            {{ pk.name ?? '（名前なし）' }}
          </div>
          <div style="font-size: 0.8rem; color: var(--color-text-subtle); margin-top: 4px">
            登録日時: {{ formatDate(pk.createdAt) }}
          </div>
        </div>
        <Button.Root
          class="btn btn-ghost"
          style="color: var(--color-danger); font-size: 0.8rem"
          @click="deletePasskey(pk.id)"
        >
          <Button.Content>削除</Button.Content>
        </Button.Root>
      </div>
    </div>

    <!-- Backup codes section -->
    <div class="card" style="padding: 16px; margin-top: 32px">
      <h3 style="margin-bottom: 8px; font-size: 1rem">バックアップコード</h3>
      <p style="font-size: 0.875rem; color: var(--color-text-muted); margin-bottom: 12px">
        パスキーが使えないときにログインできるコードです。安全な場所に保管してください。
        新しいコードを生成すると、古いコードはすべて無効になります。
      </p>
      <div v-if="backupCodeStatus" style="font-size: 0.875rem; margin-bottom: 12px">
        <span v-if="backupCodeStatus.count === 0" style="color: var(--color-text-muted)">
          バックアップコードが生成されていません
        </span>
        <span v-else>
          残り <strong>{{ backupCodeStatus.remaining }}</strong> / {{ backupCodeStatus.count }} コード
        </span>
      </div>

      <div v-if="!showGenerateConfirm">
        <Button.Root
          class="btn btn-secondary"
          :loading="generatingCodes"
          @click="backupCodeStatus && backupCodeStatus.count > 0 ? showGenerateConfirm = true : generateBackupCodes()"
        >
          <Button.Loading>生成中...</Button.Loading>
          <Button.Content>バックアップコードを生成</Button.Content>
        </Button.Root>
      </div>
      <div v-else style="display: flex; gap: 8px; align-items: center">
        <span style="font-size: 0.875rem; color: var(--color-warning)">既存のコードが無効になります。続けますか？</span>
        <Button.Root class="btn btn-danger btn-sm" @click="generateBackupCodes">
          <Button.Content>生成する</Button.Content>
        </Button.Root>
        <Button.Root class="btn btn-ghost btn-sm" @click="showGenerateConfirm = false">
          <Button.Content>キャンセル</Button.Content>
        </Button.Root>
      </div>

      <div v-if="backupCodeError" class="alert alert-error" style="margin-top: 12px">
        {{ backupCodeError }}
      </div>

      <div v-if="backupCodes.length > 0" style="margin-top: 16px">
        <p style="font-size: 0.875rem; font-weight: 600; margin-bottom: 8px; color: var(--color-warning)">
          ⚠️ このコードは今後表示されません。必ず保存してください。
        </p>
        <div
          style="
            background: var(--color-surface-raised);
            border-radius: 8px;
            padding: 16px;
            font-family: monospace;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
          "
        >
          <div
            v-for="code in backupCodes"
            :key="code"
            style="font-size: 1rem; letter-spacing: 0.05em"
          >
            {{ formatBackupCode(code) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
