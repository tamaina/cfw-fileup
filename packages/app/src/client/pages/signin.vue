<script setup lang="ts">
import { ref, reactive } from 'vue';
import { setToken, fetchCurrentUser } from '../store/auth';
import { navigateTo } from '../navigate';


const mode = ref<'signin' | 'signup'>('signin');
const form = reactive({ username: '', password: '', passphrase: '' });
const error = ref('');
const loading = ref(false);

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
  <div>
    <h2>{{ mode === 'signin' ? 'サインイン' : 'サインアップ' }}</h2>
    <form @submit.prevent="submit">
      <div>
        <label>ユーザー名<br>
          <input v-model="form.username" type="text" required autocomplete="username">
        </label>
      </div>
      <div>
        <label>パスワード<br>
          <input v-model="form.password" type="password" required autocomplete="current-password">
        </label>
      </div>
      <div v-if="mode === 'signup'">
        <label>合言葉(任意)<br>
          <input v-model="form.passphrase" type="text" autocomplete="off">
        </label>
      </div>
      <p v-if="error" style="color:red">{{ error }}</p>
      <button type="submit" :disabled="loading">
        {{ loading ? '処理中...' : (mode === 'signin' ? 'サインイン' : 'サインアップ') }}
      </button>
    </form>
    <p>
      <button type="button" @click="mode = mode === 'signin' ? 'signup' : 'signin'">
        {{ mode === 'signin' ? 'アカウントを作成する' : 'サインインページへ' }}
      </button>
    </p>
  </div>
</template>
