<script setup lang="ts">
type PlanAssignment = {
	planName: string;
	expiresAt: number;
} | null;

defineProps<{
	plan: PlanAssignment;
}>();

function formatDateTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(timestamp));
}

function isActive(plan: PlanAssignment): boolean {
	return plan != null && plan.expiresAt > Date.now();
}
</script>

<template>
  <div :class="['card', $style.card]">
    <div :class="$style.header">
      <h3 :class="$style.title">現在のプラン</h3>
      <span v-if="plan" :class="['badge', isActive(plan) ? 'badge-admin' : 'badge-warning']">
        {{ isActive(plan) ? '適用中' : '失効済み' }}
      </span>
      <span v-else class="badge badge-muted">未契約</span>
    </div>
    <dl v-if="plan" class="detail-list">
      <dt>プラン</dt>
      <dd>{{ plan.planName }}</dd>
      <dt>有効期限</dt>
      <dd>{{ formatDateTime(plan.expiresAt) }}</dd>
    </dl>
    <p v-else class="text-muted">現在の課金プランはありません。</p>
  </div>
</template>

<style module lang="scss">
.card {
  max-width: 700px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.title {
  margin: 0;
  font-size: 1rem;
}
</style>
