<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { Form } from '@vuetify/v0';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { mainRouter } from '../router';
import { setToken, fetchCurrentUser } from '../store/auth';
import { apiPost } from '../utils/api';
import type { ApiReq } from '../../shared/api';
import { navigateTo } from '../navigate';
import TurnstileWidget from '../components/turnstile-widget.vue';
import { isValidNameFormat, NAME_FORMAT_ERROR } from '../../shared/name-validation';

const signinForm = reactive({ username: '', password: '' });
const signinError = ref('');
const signinLoading = ref(false);
const passkeySigninLoading = ref(false);
const googleLoading = ref(false);
const indieauthLoading = ref(false);
const indieauthProfileUrl = ref('');

const useBackupCode = ref(false);
const backupCode = ref('');

const signupForm = reactive({ username: '', password: '', passphrase: '', passkeyName: '' });
const signupError = ref('');
const signupLoading = ref(false);
const passkeySignupError = ref('');
const passkeySignupLoading = ref(false);
const signupMethod = ref<'passkey' | 'password'>('passkey');

const passphraseRequired = ref(false);
const turnstileEnabled = ref(false);
const turnstileSiteKey = ref('');
const signinTurnstileToken = ref<string | null>(null);
const signupTurnstileToken = ref<string | null>(null);
const signupPrerequisitesConfirmed = ref(false);
const googleAuthEnabled = ref(false);
const googleRequired = ref(false);

const activeMode = computed<'signin' | 'signup'>(() => (
	mainRouter.currentRef.value.route.name === 'signup' ? 'signup' : 'signin'
));

const signupUsernameFormatError = computed(() => {
	if (!signupForm.username) return '';
	if (!isValidNameFormat(signupForm.username)) return NAME_FORMAT_ERROR;
	return '';
});

const canPasswordSignin = computed(() => !turnstileEnabled.value || signinTurnstileToken.value !== null);
const signupPrerequisitesRequired = computed(() => passphraseRequired.value || turnstileEnabled.value);
const signupPrerequisitesMet = computed(() =>
	(!signupPrerequisitesRequired.value || signupPrerequisitesConfirmed.value) &&
	(!passphraseRequired.value || !!signupForm.passphrase) &&
	(!turnstileEnabled.value || signupTurnstileToken.value !== null)
);
const signupUsernameReady = computed(() =>
	signupPrerequisitesMet.value &&
	!!signupForm.username.trim() &&
	!signupUsernameFormatError.value,
);
const canPasswordSignup = computed(() => signupUsernameReady.value);
const canPasskeySignup = computed(() => signupUsernameReady.value);
const canUseExternalAuth = computed(() =>
	activeMode.value === 'signin' || signupUsernameReady.value,
);

async function fetchMeta(): Promise<void> {
	try {
		const res = await fetch('/api/meta');
		const data = (await res.json()) as {
			passphraseRequired?: boolean;
			turnstileEnabled?: boolean;
			turnstileSiteKey?: string;
			googleAuthEnabled?: boolean;
			googleRequired?: boolean;
		};
		passphraseRequired.value = data.passphraseRequired ?? false;
		turnstileEnabled.value = data.turnstileEnabled ?? false;
		turnstileSiteKey.value = data.turnstileSiteKey ?? '';
		googleAuthEnabled.value = data.googleAuthEnabled ?? false;
		googleRequired.value = data.googleRequired ?? false;
	} catch (e) {
		console.error('Failed to fetch meta:', e);
	}
}

fetchMeta();

watch(() => signupForm.passphrase, () => {
	signupPrerequisitesConfirmed.value = false;
});

function switchMode(mode: 'signin' | 'signup'): void {
	navigateTo(mode === 'signin' ? '/signin' : '/signup');
}

function confirmSignupPrerequisites(): void {
	signupError.value = '';
	if (!signupForm.username.trim()) {
		signupError.value = 'ユーザー名を入力してください';
		return;
	}
	if (signupUsernameFormatError.value) {
		signupError.value = signupUsernameFormatError.value;
		return;
	}
	if (passphraseRequired.value && !signupForm.passphrase) {
		signupError.value = '合言葉を入力してください';
		return;
	}
	if (turnstileEnabled.value && !signupTurnstileToken.value) {
		signupError.value = 'Turnstileの確認を完了してください';
		return;
	}
	signupPrerequisitesConfirmed.value = true;
}

async function finishAuth(token: string, nextPath = '/my/buckets'): Promise<void> {
	setToken(token);
	await fetchCurrentUser();
	navigateTo(nextPath);
}

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
			signup_required: 'このGoogleアカウントは未登録です。ユーザー名と必要な確認を入力して登録してください。',
			invalid_username: 'ユーザー名の形式が正しくありません',
			username_taken: 'このユーザー名はすでに使われています',
			suspended: 'アカウントは凍結されています',
			user_creation_failed: 'ユーザー作成に失敗しました',
		};
		const message = errorMessages[googleError] ?? `Google認証エラー: ${googleError}`;
		if (activeMode.value === 'signup') {
			signupError.value = message;
		} else {
			signinError.value = message;
		}
		return;
	}

	if (!googleToken) return;

	googleLoading.value = true;
	signinError.value = '';
	signupError.value = '';
	try {
		const res = await fetch('/api/auth/google/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ googleToken }),
		});
		const data = (await res.json()) as { token?: string; error?: string };
		if (!res.ok || !data.token) {
			signinError.value = data.error ?? 'Googleサインインに失敗しました';
			return;
		}
		await finishAuth(data.token);
	} catch (e) {
		signinError.value = String(e);
	} finally {
		googleLoading.value = false;
	}
}

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
		signinError.value = errorMessages[indieauthError] ?? `IndieAuthエラー: ${indieauthError}`;
		return;
	}

	if (!indieauthToken) return;

	indieauthLoading.value = true;
	signinError.value = '';
	signupError.value = '';
	try {
		const res = await fetch('/api/auth/indieauth/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ indieauthToken }),
		});
		const data = (await res.json()) as { token?: string; error?: string };
		if (!res.ok || !data.token) {
			signinError.value = data.error ?? 'IndieAuthサインインに失敗しました';
			return;
		}
		await finishAuth(data.token);
	} catch (e) {
		signinError.value = String(e);
	} finally {
		indieauthLoading.value = false;
	}
}

handleGoogleCallback();
handleIndieAuthCallback();

function signinWithGoogle(): void {
	if (activeMode.value === 'signup' && !signupPrerequisitesMet.value) {
		signupError.value = '登録前に必要な確認を完了してください';
		return;
	}
	if (activeMode.value === 'signup' && !signupUsernameReady.value) {
		signupError.value = signupUsernameFormatError.value || 'ユーザー名を入力してください';
		return;
	}
	googleLoading.value = true;
	const params = new URLSearchParams();
	if (activeMode.value === 'signup') {
		params.set('username', signupForm.username.trim());
		if (signupForm.passphrase) {
			params.set('passphrase', signupForm.passphrase);
		}
	}
	location.href = `/api/auth/google${params.size > 0 ? `?${params.toString()}` : ''}`;
}

function signinWithIndieAuth(): void {
	if (activeMode.value === 'signup' && !signupPrerequisitesMet.value) {
		signupError.value = '登録前に必要な確認を完了してください';
		return;
	}
	if (activeMode.value === 'signup' && !signupUsernameReady.value) {
		signupError.value = signupUsernameFormatError.value || 'ユーザー名を入力してください';
		return;
	}
	const url = indieauthProfileUrl.value.trim();
	if (!url) {
		if (activeMode.value === 'signup') {
			signupError.value = 'MisskeyプロフィールURLを入力してください';
		} else {
			signinError.value = 'MisskeyプロフィールURLを入力してください';
		}
		return;
	}
	const params = new URLSearchParams({ profile_url: url });
	if (activeMode.value === 'signup') {
		params.set('username', signupForm.username.trim());
		if (signupForm.passphrase) {
			params.set('passphrase', signupForm.passphrase);
		}
	}
	indieauthLoading.value = true;
	location.href = `/api/auth/indieauth/begin?${params.toString()}`;
}

async function signinWithPassword({ valid }: { valid: boolean }): Promise<void> {
	if (!valid || !canPasswordSignin.value) return;
	signinError.value = '';
	signinLoading.value = true;
	try {
		const result = await apiPost('/api/signin', {
			username: signinForm.username,
			password: signinForm.password,
			backupCode: useBackupCode.value && backupCode.value.trim() ? backupCode.value.trim() : undefined,
			turnstileToken: turnstileEnabled.value && signinTurnstileToken.value ? signinTurnstileToken.value : undefined,
		});
		if (!result.ok) {
			signinError.value = result.data.error;
			return;
		}
		await finishAuth(result.data.token);
	} catch (e) {
		signinError.value = String(e);
	} finally {
		signinLoading.value = false;
	}
}

async function signinWithPasskey(): Promise<void> {
	signinError.value = '';
	passkeySigninLoading.value = true;
	try {
		const beginResult = await apiPost('/api/passkey/authenticate/begin');
		if (!beginResult.ok) {
			signinError.value = beginResult.data.error || 'パスキー認証の開始に失敗しました';
			return;
		}

		let credential;
		try {
			credential = await startAuthentication({
				optionsJSON: beginResult.data.options as unknown as PublicKeyCredentialRequestOptionsJSON,
			});
		} catch (e) {
			signinError.value = `パスキー認証がキャンセルされました: ${String(e)}`;
			return;
		}

		const finishResult = await apiPost('/api/passkey/authenticate/finish', {
			challengeId: beginResult.data.challengeId,
			credential: credential as unknown as ApiReq<'/api/passkey/authenticate/finish'>['credential'],
		});
		if (!finishResult.ok) {
			signinError.value = finishResult.data.error || 'パスキー認証に失敗しました';
			return;
		}
		await finishAuth(finishResult.data.token);
	} catch (e) {
		signinError.value = String(e);
	} finally {
		passkeySigninLoading.value = false;
	}
}

async function signupWithPassword({ valid }: { valid: boolean }): Promise<void> {
	if (!valid || !canPasswordSignup.value) return;
	if (signupUsernameFormatError.value) {
		signupError.value = signupUsernameFormatError.value;
		return;
	}
	signupError.value = '';
	signupLoading.value = true;
	try {
		const result = await apiPost('/api/signup', {
			username: signupForm.username.trim(),
			password: signupForm.password,
			passphrase: signupForm.passphrase || undefined,
			turnstileToken: turnstileEnabled.value && signupTurnstileToken.value ? signupTurnstileToken.value : undefined,
		});
		if (!result.ok) {
			signupError.value = result.data.error;
			return;
		}
		await finishAuth(result.data.token);
	} catch (e) {
		signupError.value = String(e);
	} finally {
		signupLoading.value = false;
	}
}

async function signupWithPasskey(): Promise<void> {
	if (!canPasskeySignup.value) {
		passkeySignupError.value = signupUsernameFormatError.value || 'ユーザー名を入力してください';
		return;
	}
	passkeySignupError.value = '';
	passkeySignupLoading.value = true;
	try {
		const beginResult = await apiPost('/api/passkey/signup/begin', {
			username: signupForm.username.trim(),
			passphrase: signupForm.passphrase || undefined,
			turnstileToken: turnstileEnabled.value && signupTurnstileToken.value ? signupTurnstileToken.value : undefined,
		});
		if (!beginResult.ok) {
			passkeySignupError.value = beginResult.data.error || 'サインアップの開始に失敗しました';
			return;
		}

		let credential;
		try {
			credential = await startRegistration({
				optionsJSON: beginResult.data.options as unknown as PublicKeyCredentialCreationOptionsJSON,
			});
		} catch (e) {
			passkeySignupError.value = `パスキーの作成がキャンセルされました: ${String(e)}`;
			return;
		}

		const finishResult = await apiPost('/api/passkey/signup/finish', {
			challengeId: beginResult.data.challengeId,
			credential: credential as unknown as ApiReq<'/api/passkey/signup/finish'>['credential'],
			passkeyName: signupForm.passkeyName.trim() || undefined,
		});
		if (!finishResult.ok) {
			passkeySignupError.value = finishResult.data.error || 'アカウント作成に失敗しました';
			return;
		}
		await finishAuth(finishResult.data.token, '/my/passkeys');
	} catch (e) {
		passkeySignupError.value = String(e);
	} finally {
		passkeySignupLoading.value = false;
	}
}
</script>

<template>
  <div :class="$style.root">
    <div :class="$style.layout">
      <section :class="['card', $style.authCard]">
        <div class="tab-bar" :class="$style.tabs" role="tablist" aria-label="認証方法">
          <button
            type="button"
            :class="[$style.tabItemButton, 'tab-btn', activeMode === 'signin' ? 'tab-btn-active' : '']"
            role="tab"
            :aria-selected="activeMode === 'signin'"
            @click="switchMode('signin')"
          >
            サインイン
          </button>
          <button
            type="button"
            :class="[$style.tabItemButton, 'tab-btn', activeMode === 'signup' ? 'tab-btn-active' : '']"
            role="tab"
            :aria-selected="activeMode === 'signup'"
            @click="switchMode('signup')"
          >
            サインアップ
          </button>
        </div>

        <template v-if="activeMode === 'signin'">
          <div v-if="googleRequired" class="alert alert-error">
            このサービスはGoogleアカウントによるサインインのみ受け付けています。
          </div>

          <div v-if="!googleRequired" :class="$style.methodBlock">
            <button
              v-if="!useBackupCode"
              type="button"
              :class="['btn', 'btn-primary', 'w-full', $style.fullButton]"
              :disabled="passkeySigninLoading"
              @click="signinWithPasskey"
            >
              {{ passkeySigninLoading ? '認証中...' : 'パスキーでログイン' }}
            </button>

            <button
              type="button"
              :class="['btn', 'btn-ghost', $style.toggleButton]"
              @click="useBackupCode = !useBackupCode"
            >
              {{ useBackupCode ? 'パスキーでログイン' : 'バックアップコードを使用' }}
            </button>

            <div v-if="signinError" class="alert alert-error">{{ signinError }}</div>
          </div>

          <div v-if="!googleRequired && !useBackupCode" :class="$style.divider">
            <hr :class="$style.dividerLine">
            <span :class="$style.dividerText">または</span>
            <hr :class="$style.dividerLine">
          </div>

          <Form v-if="!googleRequired" :class="$style.form" @submit="signinWithPassword">
            <div v-if="useBackupCode" class="form-group">
              <label class="form-label" for="backup-code">バックアップコード</label>
              <input
                id="backup-code"
                v-model="backupCode"
                :class="['form-input', $style.backupCodeInput]"
                type="text"
                autocomplete="off"
                placeholder="XXXXX-XXXXX"
              >
            </div>

            <div class="form-group">
              <label class="form-label" for="signin-username">ユーザー名</label>
              <input
                id="signin-username"
                v-model="signinForm.username"
                class="form-input"
                type="text"
                required
                autocomplete="username"
                placeholder="username"
              >
            </div>

            <div class="form-group">
              <label class="form-label" for="signin-password">パスワード</label>
              <input
                id="signin-password"
                v-model="signinForm.password"
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
              @update:token="signinTurnstileToken = $event"
            />

            <button type="submit" :class="['btn', 'btn-primary', 'w-full', $style.fullButton]" :disabled="!canPasswordSignin || signinLoading">
              {{ signinLoading ? '処理中...' : turnstileEnabled && !signinTurnstileToken ? '確認中...' : 'サインイン' }}
            </button>
          </Form>
        </template>

        <template v-else>
          <div v-if="googleRequired" class="alert alert-error">
            このサービスはGoogleアカウントによる登録のみ受け付けています。
          </div>

          <div :class="$style.form">
            <div class="form-group">
              <label class="form-label" for="signup-username">ユーザー名</label>
              <input
                id="signup-username"
                v-model="signupForm.username"
                class="form-input"
                type="text"
                required
                autocomplete="username"
                placeholder="username"
              >
              <div v-if="signupUsernameFormatError" class="form-hint form-hint--error">{{ signupUsernameFormatError }}</div>
              <div v-else class="form-hint">英数字とアンダースコア [0-9a-zA-Z_] のみ使用できます</div>
            </div>

            <div v-if="passphraseRequired" class="form-group">
              <label class="form-label" for="signup-passphrase">合言葉</label>
              <input
                id="signup-passphrase"
                v-model="signupForm.passphrase"
                class="form-input"
                type="text"
                autocomplete="off"
              >
            </div>

            <TurnstileWidget
              v-if="turnstileEnabled"
              :site-key="turnstileSiteKey"
              @update:token="signupTurnstileToken = $event"
            />

            <div v-if="signupError" class="alert alert-error">{{ signupError }}</div>

            <button
              v-if="signupPrerequisitesRequired && !signupPrerequisitesMet"
              type="button"
              :class="['btn', 'btn-primary', 'w-full', $style.fullButton]"
              @click="confirmSignupPrerequisites"
            >
              確認して続行
            </button>

            <template v-if="signupPrerequisitesMet">
              <template v-if="!googleRequired && signupMethod === 'passkey'">
                <div class="form-group">
                  <label class="form-label" for="signup-passkey-name">パスキー名（任意）</label>
                  <input
                    id="signup-passkey-name"
                    v-model="signupForm.passkeyName"
                    class="form-input"
                    type="text"
                    placeholder="例: iPhoneのFace ID"
                    maxlength="64"
                  >
                </div>

                <button
                  type="button"
                  :class="['btn', 'btn-primary', 'w-full', $style.fullButton]"
                  :disabled="passkeySignupLoading || !canPasskeySignup"
                  @click="signupWithPasskey"
                >
                  {{ passkeySignupLoading ? '処理中...' : 'パスキーで登録' }}
                </button>

                <button
                  type="button"
                  :class="['btn', 'btn-ghost', $style.toggleButton]"
                  @click="signupMethod = 'password'"
                >
                  パスワードで登録
                </button>

                <div v-if="passkeySignupError" class="alert alert-error">{{ passkeySignupError }}</div>
              </template>

              <Form v-else-if="!googleRequired" :class="$style.form" @submit="signupWithPassword">
                <div class="form-group">
                  <label class="form-label" for="signup-password">パスワード</label>
                  <input
                    id="signup-password"
                    v-model="signupForm.password"
                    class="form-input"
                    type="password"
                    required
                    autocomplete="new-password"
                    placeholder="••••••••"
                  >
                </div>

                <button type="submit" :class="['btn', 'btn-primary', 'w-full', $style.fullButton]" :disabled="!canPasswordSignup || signupLoading">
                  {{ signupLoading ? '処理中...' : '登録' }}
                </button>

                <button
                  type="button"
                  :class="['btn', 'btn-ghost', $style.toggleButton]"
                  @click="signupMethod = 'passkey'"
                >
                  パスキーで登録
                </button>
              </Form>
            </template>
          </div>
        </template>
      </section>

      <aside :class="['card', $style.ssoCard, !canUseExternalAuth && $style.ssoCardDisabled]" :aria-disabled="!canUseExternalAuth">
        <h2 :class="$style.sideTitle">外部サイト認証</h2>
        <div :class="$style.methodBlock">
          <button
            v-if="googleAuthEnabled"
            type="button"
            :class="['btn', 'btn-secondary', 'w-full', $style.fullButton]"
            :disabled="googleLoading || !canUseExternalAuth"
            @click="signinWithGoogle"
          >
            {{ googleLoading ? '処理中...' : activeMode === 'signup' ? 'Googleで登録' : 'Googleでログイン' }}
          </button>

          <div v-if="!googleRequired" :class="$style.indieauthBox">
            <input
              v-model="indieauthProfileUrl"
              class="form-input"
              type="url"
              placeholder="https://misskey.io/@username"
              autocomplete="url"
              :disabled="!canUseExternalAuth"
            >
            <button
              type="button"
              :class="['btn', 'btn-ghost', 'w-full', $style.fullButton]"
              :disabled="indieauthLoading || !canUseExternalAuth"
              @click="signinWithIndieAuth"
            >
              {{ indieauthLoading ? '処理中...' : activeMode === 'signup' ? 'Misskeyで登録' : 'Misskeyでログイン' }}
            </button>
          </div>

          <p v-if="!googleAuthEnabled && googleRequired" :class="$style.sideText">
            Google認証が設定されていません。
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>

<style module lang="scss">
.root {
  padding: 40px 16px;
}

.layout {
  display: grid;
  grid-template-columns: minmax(320px, 420px) minmax(320px, 420px);
  align-items: start;
  justify-content: center;
  gap: 20px;
}

.authCard,
.ssoCard {
  width: 100%;
}

.ssoCard {
  margin-top: 0 !important;
}

.ssoCardDisabled {
  cursor: not-allowed;
  opacity: 0.55;
  user-select: none;
}

.ssoCardDisabled :is(button, input) {
  cursor: not-allowed;
}

.tabs {
  margin-bottom: 20px;
}

.tabItemButton {
  flex: 1;
}

.methodBlock,
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.fullButton {
  justify-content: center;
}

.toggleButton {
  align-self: center;
  justify-content: center;
  padding: 3px 8px;
  font-size: 0.75rem;
}

.divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0;
}

.dividerLine {
  flex: 1;
  border: none;
  border-top: 1px solid var(--color-border);
}

.dividerText {
  color: var(--color-text-subtle);
  font-size: 0.75rem;
}

.backupCodeInput {
  font-family: monospace;
  letter-spacing: 0.05em;
}

.sideTitle {
  margin-bottom: 16px;
  font-size: 1rem;
}

.sideText {
  margin-top: 12px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.indieauthBox {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

@media (max-width: 760px) {
  .root {
    padding-top: 24px;
  }

  .layout {
    grid-template-columns: minmax(0, 480px);
  }
}
</style>
