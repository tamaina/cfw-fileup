<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { Form } from '@vuetify/v0';
import { setToken, fetchCurrentUser } from '../store/auth';
import { apiPost } from '../utils/api';
import { navigateTo } from '../navigate';
import TurnstileWidget from '../components/turnstile-widget.vue';
import { isValidNameFormat, NAME_FORMAT_ERROR } from '../../shared/name-validation';

const form = reactive({ username: '', password: '', passphrase: '' });
const error = ref('');
const loading = ref(false);

/** ユーザー名の文字種バリデーション（クライアントサイド） */
const usernameFormatError = computed(() => {
	if (!form.username) return '';
	if (!isValidNameFormat(form.username)) return NAME_FORMAT_ERROR;
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
</script>

<template>
  <div style="display:flex; justify-content:center; padding-top:48px">
    <div class="card max-w-sm" style="width:100%">
      <h2 style="margin-bottom:20px; text-align:center">アカウント作成</h2>

      <Form @submit="submit" style="display:flex; flex-direction:column; gap:14px">
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

        <button type="submit" class="btn btn-primary w-full" style="justify-content: center" :disabled="!canSubmit || loading">
          {{ loading ? '処理中...' : turnstileEnabled && !turnstileToken ? '確認中...' : 'アカウント作成' }}
        </button>
      </Form>

      <div style="margin-top:16px; text-align:center; font-size:0.875rem; color:var(--color-text-muted)">
        <button type="button" class="btn btn-ghost" @click="navigateTo('/signin')">
          サインインページへ
        </button>
      </div>
    </div>
  </div>
</template>
