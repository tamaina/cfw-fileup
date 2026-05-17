<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { Button } from '@vuetify/v0';
import { setToken, fetchCurrentUser } from '../store/auth';
import { navigateTo } from '../navigate';
import TurnstileWidget from '../components/turnstile-widget.vue';

const form = reactive({ username: '', password: '', passphrase: '' });
const error = ref('');
const loading = ref(false);
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
		if (form.passphrase) {
			body.passphrase = form.passphrase;
		}
		if (turnstileEnabled.value && turnstileToken.value) {
			body.turnstileToken = turnstileToken.value;
		}
		const res = await fetch('/api/signup', {
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
</script>

<template>
  <div style="display:flex; justify-content:center; padding-top:48px">
    <div class="card max-w-sm" style="width:100%">
      <h2 style="margin-bottom:20px; text-align:center">アカウント作成</h2>

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

        <Button.Root type="button" class="btn btn-primary w-full" style="justify-content: center" :loading="loading" :disabled="!canSubmit" @click="submit">
          <Button.Loading>処理中...</Button.Loading>
          <Button.Content>アカウント作成</Button.Content>
        </Button.Root>
      </form>

      <div style="margin-top:16px; text-align:center; font-size:0.875rem; color:var(--color-text-muted)">
        <button type="button" class="btn btn-ghost" @click="navigateTo('/signin')">
          サインインページへ
        </button>
      </div>
    </div>
  </div>
</template>
