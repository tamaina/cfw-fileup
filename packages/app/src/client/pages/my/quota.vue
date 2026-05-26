<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import CurrentPlanCard from '@/components/CurrentPlanCard.vue';
import EffectiveQuotaDetails from '@/components/EffectiveQuotaDetails.vue';
import NirA from '@/components/NirA.vue';

type EffectiveQuota = ApiSuccess<'/api/account/effective-quota'>['data'];
type CurrentPlan = ApiSuccess<'/api/account/current-plan'>['data'];

const quota = ref<EffectiveQuota | null>(null);
const currentPlan = ref<CurrentPlan>(null);
const loading = ref(true);
const error = ref('');

async function loadQuota(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const [quotaResult, currentPlanResult] = await Promise.all([
			apiPost('/api/account/effective-quota'),
			apiPost('/api/account/current-plan'),
		]);
		if (!quotaResult.ok) {
			error.value = quotaResult.data.message || 'クォータの取得に失敗しました';
			return;
		}
		if (!currentPlanResult.ok) {
			error.value = currentPlanResult.data.message || 'プランの取得に失敗しました';
			return;
		}
		quota.value = quotaResult.data;
		currentPlan.value = currentPlanResult.data;
	} catch (e) {
		error.value = String(e);
	} finally {
		loading.value = false;
	}
}

onMounted(loadQuota);
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">マイクォータ</h2>
      <NirA to="/my/payments" class="btn btn-secondary">支払い管理</NirA>
    </div>

    <div v-if="!authStore.user" class="alert alert-info">ログインが必要です。</div>
    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <div v-else :class="$style.stack">
        <div :class="['card', $style.card]">
          <EffectiveQuotaDetails :quota="quota" />
        </div>
        <CurrentPlanCard :plan="currentPlan" />
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
.card {
  max-width: 700px;
}

.stack {
  display: grid;
  gap: 16px;
}
</style>
