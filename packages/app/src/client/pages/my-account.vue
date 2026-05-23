<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Button, Form } from '@vuetify/v0';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { fetchCurrentUser, authStore, setToken } from '../store/auth';
import { apiPost } from '../utils/api';
import type { ApiReq } from '../../shared/api';

type LinkedMisskeyAccount = {
	id: string;
	misskeyId: string;
	issuer: string;
	username: string | null;
	name: string | null;
	createdAt: number;
};

const indieauthProfileUrl = ref('');
const currentPassword = ref('');
const googleLoading = ref(false);
const indieauthLoading = ref(false);
const passkeyLoading = ref(false);
const error = ref('');
const success = ref('');
const googleAuthEnabled = ref(false);
const misskeyAccounts = ref<LinkedMisskeyAccount[]>([]);

const hasGoogle = computed(() => authStore.user?.hasGoogle ?? false);
const hasMisskey = computed(() => authStore.user?.hasMisskey ?? false);
const hasPassword = computed(() => authStore.user?.hasPassword ?? true);
const recentlyAuthenticated = computed(() => authStore.user?.recentlyAuthenticated ?? false);
const canStartLink = computed(() => recentlyAuthenticated.value || (hasPassword.value && currentPassword.value.length > 0));
const isSignedIn = computed(() => authStore.user !== null);

function getMisskeyProfileUrl(account: LinkedMisskeyAccount): string {
	if (account.username) {
		return `${account.issuer}/@${account.username}`;
	}
	return account.misskeyId;
}

async function loadMeta(): Promise<void> {
	try {
		const res = await fetch('/api/meta');
		if (!res.ok) return;
		const data = await res.json() as { googleAuthEnabled?: boolean };
		googleAuthEnabled.value = data.googleAuthEnabled ?? false;
	} catch {
		googleAuthEnabled.value = false;
	}
}

async function loadMisskeyAccounts(): Promise<void> {
	if (!authStore.user) return;
	const result = await apiPost('/api/account/linked-misskey/list');
	if (result.ok) {
		misskeyAccounts.value = result.data;
	}
}

function consumeCallbackParams(): void {
	const url = new URL(location.href);
	const linkSuccess = url.searchParams.get('link_success');
	const linkError = url.searchParams.get('link_error');

	if (!linkSuccess && !linkError) return;

	url.searchParams.delete('link_success');
	url.searchParams.delete('link_error');
	history.replaceState({}, '', url.toString());

	if (linkSuccess === 'google') {
		success.value = 'Googleアカウントを連携しました';
	} else if (linkSuccess === 'misskey') {
		success.value = 'Misskeyアカウントを連携しました';
	}

	if (linkError) {
		const messages: Record<string, string> = {
			account_already_linked: 'この外部アカウントは別のユーザーに連携済みです',
			already_linked: 'このサービスはすでに連携済みです',
			link_failed: 'アカウント連携に失敗しました',
		};
		error.value = messages[linkError] ?? `アカウント連携エラー: ${linkError}`;
	}
}

async function reauthenticateWithPasskey(): Promise<void> {
	error.value = '';
	success.value = '';
	passkeyLoading.value = true;
	try {
		const beginResult = await apiPost('/api/passkey/authenticate/begin');
		if (!beginResult.ok) {
			error.value = beginResult.data.message || 'パスキー認証の開始に失敗しました';
			return;
		}

		let credential;
		try {
			credential = await startAuthentication({ optionsJSON: beginResult.data.options as unknown as PublicKeyCredentialRequestOptionsJSON });
		} catch (e) {
			error.value = `パスキー認証がキャンセルされました: ${String(e)}`;
			return;
		}

		const finishResult = await apiPost('/api/passkey/authenticate/finish', {
			challengeId: beginResult.data.challengeId,
			credential: credential as unknown as ApiReq<'/api/passkey/authenticate/finish'>['credential'],
		});
		if (!finishResult.ok) {
			error.value = finishResult.data.message || 'パスキー認証に失敗しました';
			return;
		}

		setToken(finishResult.data.token);
		await fetchCurrentUser();
		success.value = 'パスキーで再認証しました';
	} catch (e) {
		error.value = String(e);
	} finally {
		passkeyLoading.value = false;
	}
}

async function linkGoogle(): Promise<void> {
	error.value = '';
	success.value = '';
	if (!isSignedIn.value) {
		error.value = 'ログインが必要です。';
		return;
	}
	googleLoading.value = true;
	try {
		const result = await apiPost('/api/account/link/google/begin', { currentPassword: currentPassword.value || undefined });
		if (!result.ok) {
			error.value = result.data.message || 'Google連携の開始に失敗しました';
			return;
		}
		location.href = result.data.url;
	} catch (e) {
		error.value = String(e);
	} finally {
		googleLoading.value = false;
	}
}

async function linkIndieAuth({ valid }: { valid: boolean }): Promise<void> {
	if (!valid) return;
	error.value = '';
	success.value = '';
	if (!isSignedIn.value) {
		error.value = 'ログインが必要です。';
		return;
	}
	const profileUrl = indieauthProfileUrl.value.trim();
	if (!profileUrl) {
		error.value = 'プロフィールURLを入力してください';
		return;
	}

	indieauthLoading.value = true;
	try {
		const result = await apiPost('/api/account/link/indieauth/begin', { profileUrl, currentPassword: currentPassword.value || undefined });
		if (!result.ok) {
			error.value = result.data.message || 'Misskey連携の開始に失敗しました';
			return;
		}
		location.href = result.data.url;
	} catch (e) {
		error.value = String(e);
	} finally {
		indieauthLoading.value = false;
	}
}

onMounted(async () => {
	consumeCallbackParams();
	await Promise.all([fetchCurrentUser(), loadMeta()]);
	await loadMisskeyAccounts();
});
</script>

<template>
  <div :class="$style.root">
    <h1 :class="$style.title">アカウント連携</h1>

    <div v-if="success" :class="['alert', 'alert-success', $style.alert]">{{ success }}</div>
    <div v-if="error" :class="['alert', 'alert-error', $style.alert]">{{ error }}</div>

    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>

    <template v-else>
    <div :class="['card', $style.card]">
      <template v-if="recentlyAuthenticated">
        <div class="alert alert-success">再認証済みです。</div>
      </template>
      <template v-else>
        <div v-if="hasPassword" :class="$style.formGroup">
          <label class="form-label" for="current-password">現在のパスワード</label>
          <input
            id="current-password"
            v-model="currentPassword"
            class="form-input"
            type="password"
            autocomplete="current-password"
          >
        </div>
        <Button.Root
          class="btn btn-ghost"
          :disabled="passkeyLoading"
          :loading="passkeyLoading"
          @click="reauthenticateWithPasskey"
        >
          <Button.Loading>認証中...</Button.Loading>
          <Button.Content>パスキーで再認証</Button.Content>
        </Button.Root>
      </template>
    </div>

    <div v-if="googleAuthEnabled" :class="['card', $style.card]">
      <div :class="$style.serviceHeader">
        <div>
          <h2 :class="$style.serviceTitle">Google</h2>
          <p :class="$style.serviceDescription">Googleアカウントでログインできるようにします。</p>
        </div>
        <span :class="['badge', hasGoogle ? 'badge-success' : 'badge-info']">
          {{ hasGoogle ? '連携済み' : '未連携' }}
        </span>
      </div>
      <Button.Root
        class="btn btn-primary"
        :disabled="googleLoading || hasGoogle || !canStartLink"
        :loading="googleLoading"
        @click="linkGoogle"
      >
        <Button.Loading>処理中...</Button.Loading>
        <Button.Content>{{ hasGoogle ? '連携済み' : 'Googleを連携' }}</Button.Content>
      </Button.Root>
    </div>

    <div :class="['card', $style.card]">
      <div :class="$style.serviceHeader">
        <div>
          <h2 :class="$style.serviceTitle">Misskey</h2>
          <p :class="$style.serviceDescription">MisskeyのプロフィールURLから外部アカウントを連携します。</p>
        </div>
		<span :class="['badge', hasMisskey ? 'badge-success' : 'badge-info']">
	          {{ misskeyAccounts.length > 0 ? `${misskeyAccounts.length}件連携済み` : '未連携' }}
	        </span>
      </div>
      <Form :class="$style.form" @submit="linkIndieAuth">
        <div :class="$style.formGroup">
          <label class="form-label" for="indieauth-profile-url">プロフィールURL</label>
          <input
            id="indieauth-profile-url"
            v-model="indieauthProfileUrl"
            class="form-input"
            type="url"
            placeholder="https://misskey.io/@username"
	            :disabled="false"
	          >
	        </div>
        <button
          class="btn btn-primary"
          type="submit"
	          :disabled="indieauthLoading || !canStartLink"
	        >
	          {{ indieauthLoading ? '処理中...' : 'Misskeyを連携' }}
	        </button>
	      </Form>
	      <div v-if="misskeyAccounts.length > 0" :class="$style.linkedList">
	        <div v-for="account in misskeyAccounts" :key="account.id" :class="$style.linkedItem">
	          <div :class="$style.linkedName">{{ account.name || account.username || account.misskeyId }}</div>
	          <a :href="getMisskeyProfileUrl(account)" target="_blank" rel="noopener noreferrer" :class="$style.linkedLink">
	            {{ getMisskeyProfileUrl(account) }}
	          </a>
	        </div>
	      </div>
	    </div>
    </template>
  </div>
</template>

<style module lang="scss">
.root {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 16px;
}

.title {
  color: var(--color-text);
  font-size: 1.375rem;
  margin-bottom: 24px;
}

.alert {
  margin-bottom: 16px;
}

.card {
  padding: 16px;
  margin-bottom: 16px;
}

.serviceHeader {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.serviceTitle {
  color: var(--color-text);
  font-size: 1rem;
  margin: 0 0 6px;
}

.serviceDescription {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  margin: 0;
}

.form {
  display: grid;
  gap: 12px;
}

.formGroup {
  display: grid;
  gap: 6px;
}

.linkedList {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

.linkedItem {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
}

.linkedLink {
  color: var(--color-text-muted);
  display: block;
  font-size: 0.875rem;
  margin-top: 2px;
  overflow-wrap: anywhere;
  text-decoration: none;
}

.linkedName {
  color: var(--color-text);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.linkedLink:hover {
  color: var(--color-primary);
  text-decoration: underline;
}
</style>
