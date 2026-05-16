<script setup lang="ts">
import { ref, reactive } from 'vue';
import { Button } from '@vuetify/v0';
import { setToken, fetchCurrentUser } from '../store/auth';
import { navigateTo } from '../navigate';

const mode = ref<'signin' | 'signup'>('signin');
const form = reactive({ username: '', password: '', passphrase: '' });
const error = ref('');
const loading = ref(false);
const passphraseRequired = ref(false);

async function fetchMeta(): Promise<void> {
	try {
		const res = await fetch('/api/meta');
		const data = (await res.json()) as { passphraseRequired?: boolean };
		passphraseRequired.value = data.passphraseRequired ?? false;
	} catch (e) {
		console.error('Failed to fetch meta:', e);
	}
}

fetchMeta();

async function submit(): Promise<void> {
	error.value = '';
	loading.value = true;
	try {
		const path = mode.value === 'signin' ? '/api/signin' : '/api/signup';
		const body: Record<string, string> = {
			username: form.username,
			password: form.password,
		};
		if (mode.value === 'signup' && form.passphrase) {
			body.passphrase = form.passphrase;
		}
		const res = await fetch(path, {
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
      <h2 style="margin-bottom:20px; text-align:center">
        {{ mode === 'signin' ? 'サインイン' : 'アカウント作成' }}
      </h2>

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

        <div v-if="mode === 'signup' && passphraseRequired" class="form-group">
          <label class="form-label" for="passphrase">合言葉</label>
          <input
            id="passphrase"
            v-model="form.passphrase"
            class="form-input"
            type="text"
            autocomplete="off"
          >
        </div>

        <div v-if="error" class="alert alert-error">{{ error }}</div>

        <Button.Root type="submit" class="btn btn-primary w-full" :loading="loading">
          <Button.Loading>処理中...</Button.Loading>
          <Button.Content>{{ mode === 'signin' ? 'サインイン' : 'アカウント作成' }}</Button.Content>
        </Button.Root>
      </form>

      <div style="margin-top:16px; text-align:center; font-size:0.875rem; color:var(--color-text-muted)">
        <button
          type="button"
          class="btn btn-ghost"
          @click="mode = mode === 'signin' ? 'signup' : 'signin'"
        >
          {{ mode === 'signin' ? 'アカウントを作成する' : 'サインインページへ' }}
        </button>
      </div>
    </div>
  </div>
</template>
