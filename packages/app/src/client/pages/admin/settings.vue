<script setup lang="ts">
import { ref, onMounted } from 'vue';
import * as v from 'valibot';
import { authStore } from '@/store/auth';
import { apiPost } from '@/utils/api';
import NirA from '@/components/NirA.vue';
import SettingItem from '@/components/SettingItem.vue';
import { KNOWN_SETTINGS, KnownSettingRecordSchema, type KnownSettingKey } from '../../../shared/app-settings';

type SettingValues = {
	[K in KnownSettingKey]: v.InferOutput<(typeof KNOWN_SETTINGS)[K]>;
};

// デフォルト値はスキーマの optional() から導出
const defaults = Object.fromEntries(
	(Object.entries(KNOWN_SETTINGS) as [KnownSettingKey, v.GenericSchema<unknown, string>][]).map(([key, schema]) => [
		key,
		v.parse(schema, undefined),
	]),
) as SettingValues;

const values = ref<SettingValues>({ ...defaults });
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
		const map: SettingValues = { ...defaults };
		for (const s of result.data) {
			switch (s.key) {
				case 'registration_mode':
					map.registration_mode = s.value;
					break;
				case 'google_required':
					map.google_required = s.value;
					break;
				case 'terms_url':
					map.terms_url = s.value;
					break;
				case 'terms_updated_at':
					map.terms_updated_at = s.value;
					break;
				case 'indieauth_blocked_servers':
					map.indieauth_blocked_servers = s.value;
					break;
				case 'reject_mismatched_file_type':
					map.reject_mismatched_file_type = s.value;
					break;
				case 'crypto_payments_enabled':
					map.crypto_payments_enabled = s.value;
					break;
				case 'forbidden_usernames':
					map.forbidden_usernames = s.value;
					break;
				case 'forbidden_bucket_names':
					map.forbidden_bucket_names = s.value;
					break;
			}
		}
		values.value = map;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

async function saveSetting<TKey extends KnownSettingKey>(key: TKey, value: v.InferOutput<(typeof KNOWN_SETTINGS)[TKey]>): Promise<void> {
	saving.value = { ...saving.value, [key]: true };
	error.value = '';
	success.value = '';
	try {
		const payload = { key, value } as Extract<v.InferOutput<typeof KnownSettingRecordSchema>, { key: TKey }> ;
		const result = await apiPost('/api/admin/update-setting', payload);
		if (!result.ok) throw new Error('保存に失敗しました');
		success.value = `"${key}" を保存しました`;
	} catch (e) {
		error.value = String(e);
	} finally {
		saving.value = { ...saving.value, [key]: false };
	}
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

      <div v-else :class="$style.settingsGrid">
        <SettingItem
          v-model="values['registration_mode']"
          :schema="KNOWN_SETTINGS['registration_mode']"
          title="登録モード"
          :saving="saving['registration_mode']"
          :show-save-button="true"
          :save-on-change="false"
          :option-labels="{ closed: '非公開', passphrase: '合言葉必須', open: '公開' }"
          @save="saveSetting('registration_mode', $event)"
        >
          非公開: 新規登録を受け付けません。合言葉必須: 環境変数 <code>SIGNUP_PASSPHRASE</code> を知るユーザーのみ登録できます。公開: 誰でも登録できます。
        </SettingItem>

        <SettingItem
          v-model="values['google_required']"
          :schema="KNOWN_SETTINGS['google_required']"
          title="Googleアカウント登録必須"
          :saving="saving['google_required']"
          :show-save-button="true"
          :save-on-change="false"
          @save="saveSetting('google_required', $event)"
        >
          有効にすると Google アカウントによる登録・サインインのみが許可されます。
        </SettingItem>

        <SettingItem
          v-model="values['terms_url']"
          :schema="KNOWN_SETTINGS['terms_url']"
          title="利用規約URL"
          :saving="saving['terms_url']"
          :show-save-button="true"
          @save="saveSetting('terms_url', $event)"
        >
          サインアップ時に表示する利用規約ページのURLです。空欄の場合は同意チェックを表示しません。
        </SettingItem>

        <SettingItem
          v-model="values['terms_updated_at']"
          :schema="KNOWN_SETTINGS['terms_updated_at']"
          title="利用規約更新日"
          :saving="saving['terms_updated_at']"
          input-type="date"
          :show-save-button="true"
          @save="saveSetting('terms_updated_at', $event)"
        >
          YYYY-MM-DD 形式で指定します。この日付より古い同意は再確認されます。空欄の場合はURL設定時点の同意だけを確認します。
        </SettingItem>

        <SettingItem
          v-model="values['indieauth_blocked_servers']"
          :schema="KNOWN_SETTINGS['indieauth_blocked_servers']"
          title="IndieAuth ブロックサーバー"
          :saving="saving['indieauth_blocked_servers']"
          multiline
          :show-save-button="true"
          @save="saveSetting('indieauth_blocked_servers', $event)"
        >
          カンマ区切りで Misskey サーバーのホスト名を指定します。
        </SettingItem>

        <SettingItem
          v-model="values['reject_mismatched_file_type']"
          :schema="KNOWN_SETTINGS['reject_mismatched_file_type']"
          title="拡張子と内容が不一致のファイルを拒否"
          :saving="saving['reject_mismatched_file_type']"
          :show-save-button="true"
          :save-on-change="false"
          @save="saveSetting('reject_mismatched_file_type', $event)"
        >
          有効にすると、ファイルヘッダから推定した種類と拡張子が一致しないアップロードを完了時に拒否します。
        </SettingItem>

        <SettingItem
          v-model="values['crypto_payments_enabled']"
          :schema="KNOWN_SETTINGS['crypto_payments_enabled']"
          title="Crypto payments"
          :saving="saving['crypto_payments_enabled']"
          :show-save-button="true"
          :save-on-change="false"
          @save="saveSetting('crypto_payments_enabled', $event)"
        >
          有効にすると、チェーン・RPC・デプロイメント・価格設定が揃っている場合に暗号資産決済を受け付けます。
        </SettingItem>

        <SettingItem
          v-model="values['forbidden_usernames']"
          :schema="KNOWN_SETTINGS['forbidden_usernames']"
          title="禁止ユーザー名"
          :saving="saving['forbidden_usernames']"
          multiline
          :show-save-button="true"
          @save="saveSetting('forbidden_usernames', $event)"
        >
          カンマ区切りで禁止するユーザー名を指定します（大文字小文字を区別しない）。
        </SettingItem>

        <SettingItem
          v-model="values['forbidden_bucket_names']"
          :schema="KNOWN_SETTINGS['forbidden_bucket_names']"
          title="禁止バケット名"
          :saving="saving['forbidden_bucket_names']"
          multiline
          :show-save-button="true"
          @save="saveSetting('forbidden_bucket_names', $event)"
        >
          カンマ区切りで禁止するバケット名を指定します（大文字小文字を区別しない）。
        </SettingItem>
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
.settingsGrid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 700px;
}
</style>
