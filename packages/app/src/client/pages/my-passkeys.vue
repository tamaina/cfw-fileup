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
	credentialId: string;
	createdAt: number;
}

const passkeys = ref<PasskeyItem[]>([]);
const loading = ref(true);
const error = ref('');
const registerError = ref('');
const registering = ref(false);
const registerSuccess = ref('');

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

async function registerPasskey(): Promise<void> {
	registerError.value = '';
	registerSuccess.value = '';
	registering.value = true;
	try {
		// Step 1: Begin
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

		// Step 2: Prompt user for passkey
		let credential;
		try {
			credential = await startRegistration({ optionsJSON: options });
		} catch (e) {
			registerError.value = `パスキーの作成がキャンセルされました: ${String(e)}`;
			return;
		}

		// Step 3: Finish
		const finishRes = await fetch('/api/passkey/register/finish', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ challengeId, credential }),
		});
		if (!finishRes.ok) {
			const data = (await finishRes.json()) as { error?: string };
			registerError.value = data.error ?? '登録の完了に失敗しました';
			return;
		}

		registerSuccess.value = 'パスキーを登録しました';
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
		const res = await fetch(`/api/passkey/${id}`, {
			method: 'DELETE',
			headers: authHeaders(),
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

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString();
}

function truncateCredentialId(id: string): string {
	return id.length > 20 ? `${id.slice(0, 10)}...${id.slice(-10)}` : id;
}

onMounted(loadPasskeys);
</script>

<template>
  <div style="max-width: 640px; margin: 40px auto; padding: 0 16px">
    <h2 style="margin-bottom: 24px">パスキー管理</h2>

    <p style="margin-bottom: 24px; color: var(--color-text-muted); font-size: 0.9rem">
      パスキー（FIDO2 / WebAuthn）を登録すると、パスワード不要でサインインできます。
    </p>

    <div style="margin-bottom: 24px">
      <Button.Root
        class="btn btn-primary"
        :loading="registering"
        @click="registerPasskey"
      >
        <Button.Loading>登録中...</Button.Loading>
        <Button.Content>新しいパスキーを登録</Button.Content>
      </Button.Root>
    </div>

    <div v-if="registerSuccess" class="alert alert-success" style="margin-bottom: 16px">
      {{ registerSuccess }}
    </div>
    <div v-if="registerError" class="alert alert-error" style="margin-bottom: 16px">
      {{ registerError }}
    </div>

    <div v-if="loading" style="color: var(--color-text-muted)">読み込み中...</div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <div v-else-if="passkeys.length === 0" style="color: var(--color-text-muted); font-size: 0.9rem">
      登録済みのパスキーはありません。
    </div>
    <div v-else>
      <h3 style="margin-bottom: 12px; font-size: 1rem">登録済みパスキー</h3>
      <div
        v-for="pk in passkeys"
        :key="pk.id"
        class="card"
        style="margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; padding: 12px 16px"
      >
        <div>
          <div style="font-size: 0.8rem; color: var(--color-text-muted); font-family: monospace">
            {{ truncateCredentialId(pk.credentialId) }}
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
  </div>
</template>
