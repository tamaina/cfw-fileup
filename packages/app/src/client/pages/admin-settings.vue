<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button } from '@vuetify/v0';
import { authStore } from '../store/auth';
import { apiPost } from '../utils/api';
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
		const result = await apiPost('/api/admin/get-settings');
		if (!result.ok) throw new Error('設定の取得に失敗しました');
		const map: Record<string, string> = {};
		for (const s of result.data) map[s.key] = s.value;
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
		const result = await apiPost('/api/admin/update-setting', { key, value: values.value[key] });
		if (!result.ok) throw new Error('保存に失敗しました');
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
    <NirA to="/admin" class="back-link">← 管理パネルに戻る</NirA>

    <div class="section-header">
      <h2 class="section-title">アプリ設定</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="success" class="alert alert-success mb-4">{{ success }}</div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>

      <div v-else class="settings-grid">
        <div
          v-for="setting in KNOWN_SETTINGS"
          :key="setting.key"
          class="setting-row"
          :class="{ 'setting-row--multiline': setting.type === 'textarea' }"
        >
          <template v-if="setting.type === 'textarea'">
            <div style="display:flex; justify-content:space-between; align-items:center; width:100%">
              <div class="setting-row-info">
                <label :for="`setting-${setting.key}`" class="setting-row-label" style="cursor:pointer">
                  {{ setting.label }}
                </label>
                <div class="setting-row-key">{{ setting.key }}</div>
              </div>
              <Button.Root
                type="button"
                class="btn btn-primary"
                :disabled="saving[setting.key]"
                :loading="saving[setting.key]"
                @click="saveSetting(setting.key)"
              >
                <Button.Loading>保存中</Button.Loading>
                <Button.Content>保存</Button.Content>
              </Button.Root>
            </div>
            <textarea
              :id="`setting-${setting.key}`"
              v-model="values[setting.key]"
              class="form-input"
              rows="4"
              style="width:100%; resize:vertical; font-family:monospace;"
            />
          </template>

          <template v-else>
            <div class="setting-row-info">
              <label :for="`setting-${setting.key}`" class="setting-row-label" style="cursor:pointer">
                {{ setting.label }}
              </label>
              <div class="setting-row-key">{{ setting.key }}</div>
            </div>

            <div class="setting-row-control">
              <template v-if="setting.type === 'boolean'">
                <input
                  :id="`setting-${setting.key}`"
                  type="checkbox"
                  :checked="values[setting.key] === 'true'"
                  :disabled="saving[setting.key]"
                  style="width:18px; height:18px; cursor:pointer; accent-color:var(--color-primary)"
                  @change="onCheckboxChange(setting.key, ($event.target as HTMLInputElement).checked)"
                >
              </template>

              <template v-else>
              <div class="flex gap-2">
                <input
                  :id="`setting-${setting.key}`"
                  v-model="values[setting.key]"
                  class="form-input"
                  type="text"
                  style="width:160px"
                >
                <Button.Root
                  type="button"
                  class="btn btn-primary"
                  :disabled="saving[setting.key]"
                  :loading="saving[setting.key]"
                  @click="saveSetting(setting.key)"
                >
                  <Button.Loading>保存中</Button.Loading>
                  <Button.Content>保存</Button.Content>
                </Button.Root>
              </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
