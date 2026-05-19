<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { Form } from '@vuetify/v0';
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { setToken, fetchCurrentUser } from '../store/auth';
import { apiPost } from '../utils/api';
import { navigateTo } from '../navigate';
import TurnstileWidget from '../components/turnstile-widget.vue';
import { isValidNameFormat, NAME_FORMAT_ERROR } from '../../shared/name-validation';

const form = reactive({ username: '', password: '', passphrase: '' });
const error = ref('');
const loading = ref(false);

const passkeyForm = reactive({ username: '', passkeyName: '' });
const passkeyError = ref('');
const passkeyLoading = ref(false);
const showPasskeySignup = ref(false);

/** ユーザー名の文字種バリデーション（クライアントサイド） */
const usernameFormatError = computed(() => {
	if (!form.username) return '';
	if (!isValidNameFormat(form.username)) return NAME_FORMAT_ERROR;
	return '';
});
const passkeyUsernameFormatError = computed(() => {
	if (!passkeyForm.username) return '';
	if (!isValidNameFormat(passkeyForm.username)) return NAME_FORMAT_ERROR;
	return '';
});
const passphraseRequired = ref(false);
const turnstileEnabled = ref(false);
const turnstileSiteKey = ref('');
const turnstileToken = ref<string | null>(null);

async function fetchMeta(): Promise<void> {
	try {
		const res = await fetch('/api/meta');
		const data = (await res.json()) as { passphraseRequired?: boolean; turnstileEnabled?: boolean; turnstileSiteKey?: string };
		passphraseRequired.value = data.passphraseRequired ?? false;
		turnstileEnabled.value = data.turnstileEnabled ?? false;
		turnstileSiteKey.value = data.turnstileSiteKey ?? '';
	} catch (e) {
		console.error('Failed to fetch meta:', e);
	}
}

fetchMeta();

const canSubmit = computed(() =>
	(!turnstileEnabled.value || turnstileToken.value !== null) && !usernameFormatError.value,
);

async function submit({ valid }: { valid: boolean }): Promise<void> {
	if (!valid || !canSubmit.value) return;
	if (usernameFormatError.value) {
		error.value = usernameFormatError.value;
		return;
	}
	error.value = '';
	loading.value = true;
	try {
		const result = await apiPost('/api/signup', {
			username: form.username.trim(),
			password: form.password,
			passphrase: form.passphrase || undefined,
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

async function signupWithPasskey(): Promise<void> {
	if (passkeyUsernameFormatError.value) {
		passkeyError.value = passkeyUsernameFormatError.value;
		return;
	}
	passkeyError.value = '';
	passkeyLoading.value = true;
	try {
		const beginRes = await fetch('/api/passkey/signup/begin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: passkeyForm.username.trim() }),
		});
		if (!beginRes.ok) {
			const data = (await beginRes.json()) as { error?: string };
			passkeyError.value = data.error ?? 'サインアップの開始に失敗しました';
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
			passkeyError.value = `パスキーの作成がキャンセルされました: ${String(e)}`;
			return;
		}

		const finishRes = await fetch('/api/passkey/signup/finish', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				challengeId,
				credential,
				passkeyName: passkeyForm.passkeyName.trim() || undefined,
			}),
		});
		if (!finishRes.ok) {
			const data = (await finishRes.json()) as { error?: string };
			passkeyError.value = data.error ?? 'アカウント作成に失敗しました';
			return;
		}
		const data = (await finishRes.json()) as { token?: string };
		if (data.token) {
			setToken(data.token);
			await fetchCurrentUser();
			navigateTo('/my/buckets');
		}
	} catch (e) {
		passkeyError.value = String(e);
	} finally {
		passkeyLoading.value = false;
	}
}
</script>

<template>
  <div :class="$style.root">
    <div :class="[$style.card, 'card', 'max-w-sm']">
      <h2 :class="$style.heading">アカウント作成</h2>

      <!-- Password signup -->
      <template v-if="!showPasskeySignup">
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
            <div v-if="usernameFormatError" class="form-hint form-hint--error">{{ usernameFormatError }}</div>
            <div v-else class="form-hint">英数字とアンダースコア [0-9a-zA-Z_] のみ使用できます</div>
          </div>

          <div class="form-group">
            <label class="form-label" for="password">パスワード</label>
            <input
              id="password"
              v-model="form.password"
              class="form-input"
              type="password"
              required
              autocomplete="new-password"
              placeholder="••••••••"
            >
          </div>

          <div v-if="passphraseRequired" class="form-group">
            <label class="form-label" for="passphrase">合言葉</label>
            <input
              id="passphrase"
              v-model="form.passphrase"
              class="form-input"
              type="text"
              autocomplete="off"
            >
          </div>

          <TurnstileWidget
            v-if="turnstileEnabled"
            :site-key="turnstileSiteKey"
            @update:token="turnstileToken = $event"
          />

          <div v-if="error" class="alert alert-error">{{ error }}</div>

          <button type="submit" :class="[$style.submitBtn, 'btn', 'btn-primary', 'w-full']" :disabled="!canSubmit || loading">
            {{ loading ? '処理中...' : turnstileEnabled && !turnstileToken ? '確認中...' : 'アカウント作成' }}
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
            :class="['btn', 'btn-ghost', 'w-full', $style.passkeyBtn]"
            @click="showPasskeySignup = true"
          >
            パスキーでアカウント作成
          </button>
        </div>
      </template>

      <!-- Passkey signup -->
      <template v-else>
        <div :class="$style.form">
          <div class="form-group">
            <label class="form-label" for="passkey-username">ユーザー名</label>
            <input
              id="passkey-username"
              v-model="passkeyForm.username"
              class="form-input"
              type="text"
              required
              autocomplete="username"
              placeholder="username"
            >
            <div v-if="passkeyUsernameFormatError" class="form-hint form-hint--error">{{ passkeyUsernameFormatError }}</div>
            <div v-else class="form-hint">英数字とアンダースコア [0-9a-zA-Z_] のみ使用できます</div>
          </div>

          <div class="form-group">
            <label class="form-label" for="passkey-name">パスキー名（任意）</label>
            <input
              id="passkey-name"
              v-model="passkeyForm.passkeyName"
              class="form-input"
              type="text"
              placeholder="例: iPhoneのFace ID"
              maxlength="64"
            >
          </div>

          <div v-if="passkeyError" class="alert alert-error">{{ passkeyError }}</div>

          <button
            type="button"
            :class="[$style.submitBtn, 'btn', 'btn-primary', 'w-full']"
            :disabled="passkeyLoading || !passkeyForm.username || !!passkeyUsernameFormatError"
            @click="signupWithPasskey"
          >
            {{ passkeyLoading ? '処理中...' : 'パスキーでアカウント作成' }}
          </button>

          <button type="button" class="btn btn-ghost w-full" style="justify-content: center" @click="showPasskeySignup = false">
            ← パスワードで登録する
          </button>
        </div>
      </template>

      <div :class="$style.footer">
        <button type="button" class="btn btn-ghost" @click="navigateTo('/signin')">
          サインインページへ
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

.footer {
  margin-top: 16px;
  text-align: center;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}
</style>
