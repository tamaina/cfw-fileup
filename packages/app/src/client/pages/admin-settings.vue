<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { authStore } from '../store/auth';

interface Setting {
	key: string;
	value: string;
}
const settings = ref<Setting[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const success = ref('');
const newSetting = reactive({ key: '', value: '' });
const editingKey: string | null = null;

onMounted(() => {
	if (!authStore.user?.isAdmin) {
		error.value = 'Admin access required';
		return;
	}
	fetchSettings();
});

async function fetchSettings(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch('/api/admin/get-settings', {
			headers: {
				'Authorization': `Bearer ${authStore.token}`,
			},
		});
		if (!res.ok) {
			throw new Error('Failed to fetch settings');
		}
		settings.value = await res.json() as Setting[];
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function updateSetting(key: string, value: string): Promise<void> {
	saving.value = true;
	error.value = '';
	success.value = '';
	try {
		const res = await fetch('/api/admin/update-setting', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${authStore.token}`,
			},
			body: JSON.stringify({ key, value }),
		});
		if (!res.ok) {
			throw new Error('Failed to update setting');
		}
		success.value = `Setting "${key}" updated successfully`;
		await fetchSettings();
		newSetting.key = '';
		newSetting.value = '';
	} catch (e) {
		error.value = String(e);
	} finally {
		saving.value = false;
	}
}

async function addSetting(): Promise<void> {
	if (!newSetting.key || newSetting.value === '') {
		error.value = 'Key and value are required';
		return;
	}
	await updateSetting(newSetting.key, newSetting.value);
}
</script>

<template>
  <div>
    <h2>Admin Settings</h2>

    <p v-if="error" style="color: red">{{ error }}</p>
    <p v-if="success" style="color: green">{{ success }}</p>

    <div v-if="!authStore.user?.isAdmin" style="color: red">
      Admin access required
    </div>

    <div v-else>
      <section>
        <h3>Current Settings</h3>
        <div v-if="loading">Loading...</div>
        <table v-else style="border-collapse: collapse; width: 100%">
          <thead>
            <tr style="border-bottom: 1px solid #ccc">
              <th style="text-align: left; padding: 8px">Key</th>
              <th style="text-align: left; padding: 8px">Value</th>
              <th style="text-align: left; padding: 8px">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="setting in settings" :key="setting.key" style="border-bottom: 1px solid #eee">
              <td style="padding: 8px">{{ setting.key }}</td>
              <td style="padding: 8px">
                <input
                  v-model="setting.value"
                  type="text"
                  style="width: 100%; padding: 4px"
                >
              </td>
              <td style="padding: 8px">
                <button
                  @click="updateSetting(setting.key, setting.value)"
                  :disabled="saving"
                >
                  Save
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section style="margin-top: 20px">
        <h3>Add New Setting</h3>
        <div style="margin-bottom: 8px">
          <label>Key<br>
            <input v-model="newSetting.key" type="text" style="width: 100%; padding: 4px">
          </label>
        </div>
        <div style="margin-bottom: 8px">
          <label>Value<br>
            <input v-model="newSetting.value" type="text" style="width: 100%; padding: 4px">
          </label>
        </div>
        <button @click="addSetting" :disabled="saving">
          Add Setting
        </button>
      </section>
    </div>
  </div>
</template>
