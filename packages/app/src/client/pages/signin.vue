<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { Button } from '@vuetify/v0';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { setToken, fetchCurrentUser } from '../store/auth';
import { navigateTo } from '../navigate';
import TurnstileWidget from '../components/turnstile-widget.vue';

const form = reactive({ username: '', password: '' });
const error = ref('');
const loading = ref(false);
const passkeyLoading = ref(false);
const googleLoading = ref(false);
const indieauthLoading = ref(false);
const indieauthProfileUrl = ref('');
const turnstileEnabled = ref(false);
const turnstileSiteKey = ref('');
const turnstileToken = ref<string | null>(null);
const googleAuthEnabled = ref(false);
const googleRequired = ref(false);
const indieAuthEnabled = ref(false);

async function fetchMeta(): Promise<void> {
	try {
		const res = await fetch('/api/meta');
		const data = (await res.json()) as { turnstileEnabled?: boolean; turnstileSiteKey?: string; googleAuthEnabled?: boolean; googleRequired?: boolean; indieAuthEnabled?: boolean };
		turnstileEnabled.value = data.turnstileEnabled ?? false;
		turnstileSiteKey.value = data.turnstileSiteKey ?? '';
		googleAuthEnabled.value = data.googleAuthEnabled ?? false;
		googleRequired.value = data.googleRequired ?? false;
		indieAuthEnabled.value = data.indieAuthEnabled ?? true;
	} catch (e) {
		console.error('Failed to fetch meta:', e);
	}
}

// Handle IndieAuth callback
async function handleIndieAuthCallback(): Promise<void> {
	const params = new URLSearchParams(window.location.search);
	const indieauthToken = params.get('indieauth_token');
	const indieauthError = params.get('indieauth_error');

	const newUrl = new URL(window.location.href);
	newUrl.searchParams.delete('indieauth_token');
	newUrl.searchParams.delete('indieauth_error');
	window.history.replaceState({}, '', newUrl.toString());

	if (indieauthError) {
		const errorMessages: Record<string, string> = {
			missing_params: 'パラメータが不足しています',
			invalid_state: '無効または期限切れのセッションです',
			missing_verifier: 'セッション情報が不正です',
			server_blocked: 'このMisskeyサーバーは許可されていません',
			discovery_failed: 'IndieAuth認証エンドポイントを見つけられませんでした',
			no_token_endpoint: 'IndieAuthトークンエンドポイントを見つけられませんでした',
			token_exchange_failed: 'トークン交換に失敗しました',
			suspended: 'アカウントが停止されています',
			registration_closed: '新規登録は現在受け付けていません',
			user_creation_failed: 'ユーザー作成に失敗しました',
		};
		error.value = errorMessages[indieauthError] ?? `IndieAuthエラー: ${indieauthError}`;
		return;
	}

	if (!indieauthToken) return;

	indieauthLoading.value = true;
	error.value = '';
	try {
		const res = await fetch('/api/auth/indieauth/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ indieauthToken }),
		});
		const data = (await res.json()) as { token?: string; error?: string };
		if (!res.ok) {
			error.value = data.error ?? 'Misskeyサインインに失敗しました';
			return;
		}
		if (data.token) {
			setToken(data.token);
			await fetchCurrentUser();
			navigateTo('/my/buckets');
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		indieauthLoading.value = false;
	}
}

// Handle Google OAuth callback token in query parameter
async function handleGoogleCallback(): Promise<void> {
	const params = new URLSearchParams(window.location.search);
	const googleToken = params.get('google_token');
	if (!googleToken) return;

	// Remove the token from the URL immediately
	const newUrl = new URL(window.location.href);
	newUrl.searchParams.delete('google_token');
	window.history.replaceState({}, '', newUrl.toString());

	googleLoading.value = true;
	error.value = '';
	try {
		const res = await fetch('/api/auth/google/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ googleToken }),
		});
		const data = (await res.json()) as { token?: string; error?: string };
		if (!res.ok) {
			error.value = data.error ?? 'Googleサインインに失敗しました';
			return;
		}
		if (data.token) {
			setToken(data.token);
			await fetchCurrentUser();
			navigateTo('/my/buckets');
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		googleLoading.value = false;
	}
}

onMounted(async () => {
	await fetchMeta();
	await handleIndieAuthCallback();
	await handleGoogleCallback();
});

const canSubmit = computed(() => !turnstileEnabled.value || turnstileToken.value !== null);

async function submit(): Promise<void> {
	if (!canSubmit.value) return;
	error.value = '';
	loading.value = true;
	try {
		const body: Record<string, string> = {
			username: form.username,
			password: form.password,
		};
		if (turnstileEnabled.value && turnstileToken.value) {
			body.turnstileToken = turnstileToken.value;
		}
		const res = await fetch('/api/signin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const data = (await res.json()) as { token?: string; error?: string };
		if (!res.ok) {
			error.value = data.error ?? 'エラーが発生しました';
			return;
		}
		if (data.token) {
			setToken(data.token);
			await fetchCurrentUser();
			navigateTo('/my/buckets');
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function signinWithPasskey(): Promise<void> {
	error.value = '';
	passkeyLoading.value = true;
	try {
		// Step 1: Begin authentication
		const beginRes = await fetch('/api/passkey/authenticate/begin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		});
		if (!beginRes.ok) {
			const data = (await beginRes.json()) as { error?: string };
			error.value = data.error ?? 'パスキー認証の開始に失敗しました';
			return;
		}
		const { challengeId, options } = (await beginRes.json()) as {
			challengeId: string;
			options: PublicKeyCredentialRequestOptionsJSON;
		};

		// Step 2: Prompt user
		let credential;
		try {
			credential = await startAuthentication({ optionsJSON: options });
		} catch (e) {
			error.value = `パスキー認証がキャンセルされました: ${String(e)}`;
			return;
		}

		// Step 3: Finish authentication
		const finishRes = await fetch('/api/passkey/authenticate/finish', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ challengeId, credential }),
		});
		const finishData = (await finishRes.json()) as { token?: string; error?: string };
		if (!finishRes.ok) {
			error.value = finishData.error ?? 'パスキー認証に失敗しました';
			return;
		}
		if (finishData.token) {
			setToken(finishData.token);
			await fetchCurrentUser();
			navigateTo('/my/buckets');
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		passkeyLoading.value = false;
	}
}

function signinWithGoogle(): void {
	location.href = '/api/auth/google';
}

function signinWithIndieAuth(): void {
	const url = indieauthProfileUrl.value.trim();
	if (!url) {
		error.value = 'MisskeyのプロフィールURLを入力してください';
		return;
	}
	indieauthLoading.value = true;
	location.href = `/api/auth/indieauth/begin?profile_url=${encodeURIComponent(url)}`;
}
</script>

<template>
  <div style="display:flex; justify-content:center; padding-top:48px">
    <div class="card max-w-sm" style="width:100%">
      <h2 style="margin-bottom:20px; text-align:center">サインイン</h2>

      <form @submit.prevent="submit" style="display:flex; flex-direction:column; gap:14px">
        <div class="form-group">
          <label class="form-label" for="username">ユーザー名</label>
          <input
            id="username"
            v-model="form.username"
            class="form-input"
            type="text"
            required
            autocomplete="username"
            placeholder="username"
          >
        </div>

        <div class="form-group">
          <label class="form-label" for="password">パスワード</label>
          <input
            id="password"
            v-model="form.password"
            class="form-input"
            type="password"
            required
            autocomplete="current-password"
            placeholder="••••••••"
          >
        </div>

        <TurnstileWidget
          v-if="turnstileEnabled"
          :site-key="turnstileSiteKey"
          @update:token="turnstileToken = $event"
        />

        <div v-if="error" class="alert alert-error">{{ error }}</div>

        <Button.Root type="button" class="btn btn-primary w-full" style="justify-content: center" :loading="loading" :disabled="!canSubmit" @click="submit">
          <Button.Loading>処理中...</Button.Loading>
          <Button.Content>サインイン</Button.Content>
        </Button.Root>
      </form>

      <div style="margin-top:16px; display:flex; flex-direction:column; align-items:center; gap:8px">
        <div style="display:flex; align-items:center; width:100%; gap:8px">
          <hr style="flex:1; border:none; border-top:1px solid var(--color-border)">
          <span style="font-size:0.75rem; color:var(--color-text-subtle)">または</span>
          <hr style="flex:1; border:none; border-top:1px solid var(--color-border)">
        </div>
        <Button.Root
          type="button"
          class="btn btn-ghost w-full"
          style="justify-content:center"
          :loading="passkeyLoading"
          @click="signinWithPasskey"
        >
          <Button.Loading>認証中...</Button.Loading>
          <Button.Content>パスキーでサインイン</Button.Content>
        </Button.Root>
        <Button.Root
          v-if="googleAuthEnabled"
          type="button"
          class="btn btn-ghost w-full"
          style="justify-content:center"
          :loading="googleLoading"
          @click="signinWithGoogle"
        >
          <Button.Loading>認証中...</Button.Loading>
          <Button.Content>Googleでサインイン</Button.Content>
        </Button.Root>
        <template v-if="indieAuthEnabled">
          <div style="display:flex; gap:8px; width:100%">
            <input
              v-model="indieauthProfileUrl"
              class="form-input"
              type="url"
              placeholder="https://misskey.io/@username"
              style="flex:1"
              @keydown.enter.prevent="signinWithIndieAuth"
            >
            <Button.Root
              type="button"
              class="btn btn-ghost"
              :loading="indieauthLoading"
              @click="signinWithIndieAuth"
            >
              <Button.Loading>認証中...</Button.Loading>
              <Button.Content>Misskeyでサインイン</Button.Content>
            </Button.Root>
          </div>
        </template>
      </div>

      <div style="margin-top:16px; text-align:center; font-size:0.875rem; color:var(--color-text-muted)">
        <button type="button" class="btn btn-ghost" @click="navigateTo('/signup')">
          アカウントを作成する
        </button>
      </div>
    </div>
  </div>
</template>
