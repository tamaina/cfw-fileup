<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { Form } from '@vuetify/v0';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { setToken, fetchCurrentUser } from '../store/auth';
import { apiPost } from '../utils/api';
import type { ApiReq } from '../../shared/api';
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

// Backup code mode
const showBackupCode = ref(false);
const backupForm = reactive({ username: '', password: '', code: '' });
const backupLoading = ref(false);
const backupError = ref('');

async function fetchMeta(): Promise<void> {
	try {
		const res = await fetch('/api/meta');
		const data = (await res.json()) as {
			turnstileEnabled?: boolean;
			turnstileSiteKey?: string;
			googleAuthEnabled?: boolean;
		};
		turnstileEnabled.value = data.turnstileEnabled ?? false;
		turnstileSiteKey.value = data.turnstileSiteKey ?? '';
		googleAuthEnabled.value = data.googleAuthEnabled ?? false;
	} catch (e) {
		console.error('Failed to fetch meta:', e);
	}
}

fetchMeta();

async function handleGoogleCallback(): Promise<void> {
	const params = new URLSearchParams(window.location.search);
	const googleToken = params.get('google_token');
	const googleError = params.get('google_error');
	if (!googleToken && !googleError) return;

	const newUrl = new URL(window.location.href);
	newUrl.searchParams.delete('google_token');
	newUrl.searchParams.delete('google_error');
	window.history.replaceState({}, '', newUrl.toString());

	if (googleError) {
		const errorMessages: Record<string, string> = {
			access_denied: 'Google認証がキャンセルされました',
			missing_params: 'Google認証情報が不足しています',
			invalid_state: 'Google認証のstateが無効です',
			token_exchange_failed: 'Google token の交換に失敗しました',
			userinfo_failed: 'Googleアカウント情報の取得に失敗しました',
			registration_closed: '新規登録は停止されています',
			signup_required: 'このGoogleアカウントは未登録です。サインアップ画面から登録してください。',
			invalid_username: 'ユーザー名の形式が正しくありません',
			username_taken: 'このユーザー名はすでに使われています',
			suspended: 'アカウントは凍結されています',
			user_creation_failed: 'ユーザー作成に失敗しました',
		};
		error.value = errorMessages[googleError] ?? `Google認証エラー: ${googleError}`;
		return;
	}

	if (!googleToken) return;

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

handleGoogleCallback();

async function handleIndieAuthCallback(): Promise<void> {
	const params = new URLSearchParams(window.location.search);
	const indieauthToken = params.get('indieauth_token');
	const indieauthError = params.get('indieauth_error');
	if (!indieauthToken && !indieauthError) return;

	const newUrl = new URL(window.location.href);
	newUrl.searchParams.delete('indieauth_token');
	newUrl.searchParams.delete('indieauth_error');
	window.history.replaceState({}, '', newUrl.toString());

	if (indieauthError) {
		const errorMessages: Record<string, string> = {
			access_denied: 'IndieAuthがキャンセルされました',
			missing_params: 'IndieAuthの認証情報が不足しています',
			invalid_state: 'IndieAuthのstateが無効です',
			server_blocked: 'このMisskeyサーバーは許可されていません',
			discovery_failed: 'IndieAuthエンドポイントの検出に失敗しました',
			no_token_endpoint: 'IndieAuth token endpoint が見つかりません',
			token_exchange_failed: 'IndieAuth token の交換に失敗しました',
			registration_closed: '新規登録は停止されています',
			invalid_passphrase: '合言葉が正しくありません',
			missing_username: 'ユーザー名を入力してから登録してください',
			invalid_username: 'ユーザー名の形式が正しくありません',
			username_taken: 'このユーザー名はすでに使われています',
			suspended: 'アカウントは凍結されています',
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
			error.value = data.error ?? 'IndieAuthサインインに失敗しました';
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

handleIndieAuthCallback();

const canSubmit = computed(() => !turnstileEnabled.value || turnstileToken.value !== null);

async function submit({ valid }: { valid: boolean }): Promise<void> {
	if (!valid || !canSubmit.value) return;
	error.value = '';
	loading.value = true;
	try {
		const result = await apiPost('/api/signin', {
			username: form.username,
			password: form.password,
			turnstileToken: turnstileEnabled.value && turnstileToken.value ? turnstileToken.value : undefined,
		});
		if (!result.ok) {
			error.value = result.data.error;
			return;
		}
		if (result.data.token) {
			setToken(result.data.token);
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
		const beginResult = await apiPost('/api/passkey/authenticate/begin');
		if (!beginResult.ok) {
			error.value = beginResult.data.error || 'パスキー認証の開始に失敗しました';
			return;
		}
		const { challengeId, options } = beginResult.data;

		let credential;
		try {
			credential = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
		} catch (e) {
			error.value = `パスキー認証がキャンセルされました: ${String(e)}`;
			return;
		}

		const finishResult = await apiPost('/api/passkey/authenticate/finish', {
			challengeId,
			credential: credential as unknown as ApiReq<'/api/passkey/authenticate/finish'>['credential'],
		});
		if (!finishResult.ok) {
			error.value = finishResult.data.error || 'パスキー認証に失敗しました';
			return;
		}
		if (finishResult.data.token) {
			setToken(finishResult.data.token);
			await fetchCurrentUser();
			navigateTo('/my/buckets');
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		passkeyLoading.value = false;
	}
}

async function signinWithBackupCode({ valid }: { valid: boolean }): Promise<void> {
	if (!valid) return;
	backupError.value = '';
	backupLoading.value = true;
	try {
		const result = await apiPost('/api/passkey/backup-codes/use', {
			username: backupForm.username,
			password: backupForm.password,
			code: backupForm.code,
		});
		if (!result.ok) {
			backupError.value = result.data.error || 'バックアップコードの認証に失敗しました';
			return;
		}
		if (result.data.token) {
			setToken(result.data.token);
			await fetchCurrentUser();
			navigateTo('/my/buckets');
		}
	} catch (e) {
		backupError.value = String(e);
	} finally {
		backupLoading.value = false;
	}
}

function signinWithGoogle(): void {
	location.href = '/api/auth/google';
}

function signinWithIndieAuth(): void {
	const url = indieauthProfileUrl.value.trim();
	if (!url) {
		error.value = 'MisskeyプロフィールURLを入力してください';
		return;
	}
	indieauthLoading.value = true;
	location.href = `/api/auth/indieauth/begin?profile_url=${encodeURIComponent(url)}`;
}
</script>

<template>
  <div :class="$style.root">
    <div :class="[$style.card, 'card', 'max-w-sm']">
      <h2 :class="$style.heading">サインイン</h2>

      <!-- Password signin -->
      <template v-if="!showBackupCode">
        <Form :class="$style.form" @submit="submit">
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

          <button type="submit" :class="[$style.submitBtn, 'btn', 'btn-primary', 'w-full']" :disabled="!canSubmit || loading">
            {{ loading ? '処理中...' : turnstileEnabled && !turnstileToken ? '確認中...' : 'サインイン' }}
          </button>
        </Form>

        <div :class="$style.passkeySection">
          <div :class="$style.divider">
            <hr :class="$style.dividerLine">
            <span :class="$style.dividerText">または</span>
            <hr :class="$style.dividerLine">
          </div>
          <button
            type="button"
            :class="[$style.passkeyBtn, 'btn', 'btn-ghost', 'w-full']"
            :disabled="passkeyLoading"
            @click="signinWithPasskey"
          >
            {{ passkeyLoading ? '認証中...' : 'パスキーでサインイン' }}
          </button>
          <button
            type="button"
            :class="[$style.passkeyBtn, $style.backupCodeButton, 'btn', 'btn-ghost', 'w-full']"
            @click="showBackupCode = true"
          >
            バックアップコードでサインイン
          </button>
          <button
            v-if="googleAuthEnabled"
            type="button"
            :class="[$style.passkeyBtn, 'btn', 'btn-ghost', 'w-full']"
            :disabled="googleLoading"
            @click="signinWithGoogle"
          >
            {{ googleLoading ? '処理中...' : 'Googleでサインイン' }}
          </button>
          <div :class="$style.indieauthBox">
            <input
              v-model="indieauthProfileUrl"
              class="form-input"
              type="url"
              placeholder="https://misskey.io/@username"
              autocomplete="url"
            >
            <button
              type="button"
              :class="[$style.passkeyBtn, 'btn', 'btn-ghost', 'w-full']"
              :disabled="indieauthLoading"
              @click="signinWithIndieAuth"
            >
              {{ indieauthLoading ? '処理中...' : 'Misskeyでサインイン' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Backup code signin -->
      <template v-else>
        <Form :class="$style.form" @submit="signinWithBackupCode">
          <div class="form-group">
            <label class="form-label" for="backup-username">ユーザー名</label>
            <input
              id="backup-username"
              v-model="backupForm.username"
              class="form-input"
              type="text"
              required
              autocomplete="username"
              placeholder="username"
            >
          </div>

          <div class="form-group">
            <label class="form-label" for="backup-code">バックアップコード</label>
            <input
              id="backup-code"
              v-model="backupForm.code"
              class="form-input"
              type="text"
              required
              autocomplete="off"
              placeholder="XXXXX-XXXXX"
              :class="$style.backupCodeInput"
            >
          </div>

          <div class="form-group">
            <label class="form-label" for="backup-password">パスワード</label>
            <input
              id="backup-password"
              v-model="backupForm.password"
              class="form-input"
              type="password"
              required
              autocomplete="current-password"
              placeholder="••••••••"
            >
          </div>

          <div v-if="backupError" class="alert alert-error">{{ backupError }}</div>

          <button type="submit" :class="[$style.submitBtn, 'btn', 'btn-primary', 'w-full']" :disabled="backupLoading">
            {{ backupLoading ? '処理中...' : 'サインイン' }}
          </button>
        </Form>

        <div :class="$style.backLinkRow">
          <button type="button" :class="['btn', 'btn-ghost', $style.backLinkButton]" @click="showBackupCode = false">
            ← 通常のサインインに戻る
          </button>
        </div>
      </template>

      <div :class="$style.footer">
        <button type="button" class="btn btn-ghost" @click="navigateTo('/signup')">
          アカウントを作成する
        </button>
      </div>
    </div>
  </div>
</template>

<style module lang="scss">
.root {
  display: flex;
  justify-content: center;
  padding-top: 48px;
}

.card {
  width: 100%;
}

.heading {
  margin-bottom: 20px;
  text-align: center;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.submitBtn {
  justify-content: center;
}

.passkeySection {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.divider {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
}

.dividerLine {
  flex: 1;
  border: none;
  border-top: 1px solid var(--color-border);
}

.dividerText {
  font-size: 0.75rem;
  color: var(--color-text-subtle);
}

.passkeyBtn {
  justify-content: center;
}

.backupCodeButton {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.backupCodeInput {
  font-family: monospace;
  letter-spacing: 0.05em;
}

.indieauthBox {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 8px;
}

.backLinkRow {
  margin-top: 12px;
  text-align: center;
}

.backLinkButton {
  font-size: 0.875rem;
}

.footer {
  margin-top: 16px;
  text-align: center;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}
</style>
