<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { authStore, authHeaders } from '../store/auth';
import NirA from '@/components/nira.vue';
import { KNOWN_SETTINGS } from '../../shared/app-settings';

const values = ref<Record<string, string>>({});
const loading = ref(true);
const saving = ref<Record<string, boolean>>({});
const error = ref('');
const success = ref('');

onMounted(fetchSettings);

async function fetchSettings(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch('/api/admin/get-settings', { headers: authHeaders() });
		if (!res.ok) throw new Error('設定の取得に失敗しました');
		const data = await res.json() as { key: string; value: string }[];
		const map: Record<string, string> = {};
		for (const s of data) map[s.key] = s.value;
		// fill in defaults for known settings not yet in DB
		for (const s of KNOWN_SETTINGS) {
			map[s.key] ??= s.defaultValue;
		}
		values.value = map;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function saveSetting(key: string): Promise<void> {
	saving.value = { ...saving.value, [key]: true };
	error.value = '';
	success.value = '';
	try {
		const res = await fetch('/api/admin/update-setting', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ key, value: values.value[key] }),
		});
		if (!res.ok) throw new Error('保存に失敗しました');
		success.value = `"${key}" を保存しました`;
	} catch (e) {
		error.value = String(e);
	} finally {
		saving.value = { ...saving.value, [key]: false };
	}
}

function onCheckboxChange(key: string, checked: boolean): void {
	values.value = { ...values.value, [key]: checked ? 'true' : 'false' };
	void saveSetting(key);
}
</script>

<template>
  <div>
    <h2>アプリ設定</h2>
    <NirA to="/admin">← 管理パネルに戻る</NirA>

    <div v-if="!authStore.user?.isAdmin" style="color:red; margin-top:12px">
      管理者権限が必要です。
    </div>

    <template v-else>
      <p v-if="error" style="color:red; margin-top:12px">{{ error }}</p>
      <p v-if="success" style="color:green; margin-top:12px">{{ success }}</p>

      <div v-if="loading" style="margin-top:12px">読み込み中...</div>

      <div v-else style="display:grid; gap:16px; margin-top:16px; max-width:480px">
        <div
          v-for="setting in KNOWN_SETTINGS"
          :key="setting.key"
          style="display:flex; align-items:center; justify-content:space-between; padding:10px; border:1px solid #ddd; border-radius:4px"
        >
          <label :for="`setting-${setting.key}`" style="cursor:pointer">
            {{ setting.label }}
            <span style="display:block; color:#888; font-size:0.8em">{{ setting.key }}</span>
          </label>

          <template v-if="setting.type === 'boolean'">
            <input
              :id="`setting-${setting.key}`"
              type="checkbox"
              :checked="values[setting.key] === 'true'"
              :disabled="saving[setting.key]"
              style="width:18px; height:18px; cursor:pointer"
              @change="onCheckboxChange(setting.key, ($event.target as HTMLInputElement).checked)"
            >
          </template>

          <template v-else>
            <div style="display:flex; gap:8px">
              <input
                :id="`setting-${setting.key}`"
                v-model="values[setting.key]"
                type="text"
                style="padding:4px 8px"
              >
              <button
                type="button"
                :disabled="saving[setting.key]"
                @click="saveSetting(setting.key)"
              >
                保存
              </button>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
