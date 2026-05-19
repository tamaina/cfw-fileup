<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { Form } from '@vuetify/v0';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { setToken, fetchCurrentUser } from '../store/auth';
import { apiPost } from '../utils/api';
import { navigateTo } from '../navigate';
import TurnstileWidget from '../components/turnstile-widget.vue';

const form = reactive({ username: '', password: '' });
const error = ref('');
const loading = ref(false);
const passkeyLoading = ref(false);
const turnstileEnabled = ref(false);
const turnstileSiteKey = ref('');
const turnstileToken = ref<string | null>(null);

async function fetchMeta(): Promise<void> {
	try {
		const res = await fetch('/api/meta');
		const data = (await res.json()) as { turnstileEnabled?: boolean; turnstileSiteKey?: string };
		turnstileEnabled.value = data.turnstileEnabled ?? false;
		turnstileSiteKey.value = data.turnstileSiteKey ?? '';
	} catch (e) {
		console.error('Failed to fetch meta:', e);
	}
}

fetchMeta();

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
</script>

<template>
  <div :class="$style.root">
    <div :class="[$style.card, 'card', 'max-w-sm']">
      <h2 :class="$style.heading">サインイン</h2>

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
      </div>

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

.footer {
  margin-top: 16px;
  text-align: center;
  font-size: 0.875rem;
  color: var(--color-text-muted);
}
</style>
