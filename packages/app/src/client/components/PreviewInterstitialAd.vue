<script lang="ts">
const previewInterstitialCooldownMs = 60_000;
let lastPreviewInterstitialShownAt = 0;
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Button } from '@vuetify/v0';
import { BadgeJapaneseYen, ExternalLink, Sparkles } from '@lucide/vue';
import { authStore } from '@/store/auth';
import { appName } from '@/store/app-meta';
import { apiPost } from '@/utils/api';
import NirA from '@/components/NirA.vue';

const props = withDefaults(defineProps<{
	ownerCanDisableFileAds?: boolean;
}>(), {
	ownerCanDisableFileAds: false,
});

const emit = defineEmits<{
	(e: 'complete'): void;
}>();

const loading = ref(true);
const loaded = ref(false);
const viewerShowAds = ref(true);
const dismissed = ref(false);
const readyToShow = ref(false);

const adsenseClient = import.meta.env.VITE_GOOGLE_ADSENSE_CLIENT as string | undefined;

function isInCooldown(): boolean {
	return Date.now() - lastPreviewInterstitialShownAt < previewInterstitialCooldownMs;
}

const shouldShow = computed(() => readyToShow.value && viewerShowAds.value && !props.ownerCanDisableFileAds);
const linkTo = computed(() => authStore.user ? '/my/payments' : '/signup');
const actionLabel = computed(() => authStore.user ? 'プランを見る' : 'アカウント作成');
const message = computed(() => authStore.user
	? 'プラン契約で広告なしのファイル共有と追加機能を利用できます。'
	: 'アカウント作成後、プラン契約で広告なしのファイル共有を利用できます。');

function complete(): void {
	lastPreviewInterstitialShownAt = Date.now();
	dismissed.value = true;
	emit('complete');
}

async function loadAdsense(): Promise<void> {
	if (!adsenseClient) return;
	const scriptId = 'google-adsense-script';
	if (!document.getElementById(scriptId)) {
		const script = document.createElement('script');
		script.id = scriptId;
		script.async = true;
		script.crossOrigin = 'anonymous';
		script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(adsenseClient ?? '')}`;
		document.head.append(script);
	}
}

async function loadCurrentPlan(): Promise<void> {
	if (loaded.value) return;
	loading.value = true;
	try {
		if (authStore.user) {
			const quotaResult = await apiPost('/api/account/effective-quota');
			if (quotaResult.ok) viewerShowAds.value = quotaResult.data.showAds;
		}
	} finally {
		loading.value = false;
		loaded.value = true;
		void loadAdsense();
		if (!viewerShowAds.value || props.ownerCanDisableFileAds || isInCooldown()) {
			emit('complete');
		} else {
			readyToShow.value = true;
		}
	}
}

onMounted(() => {
	void loadCurrentPlan();
});
</script>

<template>
  <div v-if="shouldShow && !dismissed" :class="$style.overlay" role="dialog" aria-modal="true" aria-label="広告">
    <section :class="$style.panel">
      <div :class="$style.adArea">
        <div :class="$style.planAd">
          <div :class="$style.planIcon" aria-hidden="true">
            <BadgeJapaneseYen :size="26" :stroke-width="2" />
          </div>
          <div :class="$style.planCopy">
            <div :class="$style.kicker">{{ appName }} Plan</div>
            <h2 :class="$style.title">広告なしでファイルをプレビュー</h2>
            <p :class="$style.message">{{ message }}</p>
          </div>
        </div>
      </div>
      <div :class="$style.actions">
        <Button.Root :as="NirA" :to="linkTo" class="btn btn-primary" :class="$style.action">
          <Button.Content>
            <Sparkles :size="16" :stroke-width="2" aria-hidden="true" />
            {{ actionLabel }}
            <ExternalLink :size="15" :stroke-width="2" aria-hidden="true" />
          </Button.Content>
        </Button.Root>
        <button type="button" class="btn btn-secondary" :class="$style.action" @click="complete">
          ファイルに進む
        </button>
      </div>
    </section>
  </div>
</template>

<style module lang="scss">
.overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.72);
  backdrop-filter: blur(3px);
}

.panel {
  display: grid;
  gap: 18px;
  width: min(760px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
  padding: 24px;
}

.adArea {
  display: grid;
  min-height: 320px;
  border: 1px solid #f59e0b;
  border-radius: var(--radius);
  background: linear-gradient(135deg, #fff7ed 0%, var(--color-surface) 58%, #fffbeb 100%);
  overflow: hidden;
}

.planAd {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 18px;
  padding: 32px;
}

.planIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  color: #9a3412;
  background: #fed7aa;
  border: 1px solid #fdba74;
  border-radius: var(--radius);
}

.planCopy {
  min-width: 0;
}

.kicker {
  color: #c2410c;
  font-size: 0.78rem;
  font-weight: 700;
}

.title {
  margin: 4px 0 8px;
  font-size: 1.45rem;
}

.message {
  margin: 0;
  color: var(--color-text-muted);
  line-height: 1.7;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.action {
  min-height: 38px;
}

:global([data-theme="dark"]) .adArea {
  border-color: #c2410c;
  background: linear-gradient(135deg, #2a170b 0%, var(--color-surface) 58%, #221807 100%);
}

:global([data-theme="dark"]) .planIcon {
  color: #fed7aa;
  background: #7c2d12;
  border-color: #c2410c;
}

:global([data-theme="dark"]) .kicker {
  color: #fdba74;
}

@media (max-width: 640px) {
  .overlay {
    padding: 12px;
  }

  .panel {
    max-height: calc(100vh - 24px);
    padding: 16px;
  }

  .adArea {
    min-height: 260px;
  }

  .planAd {
    grid-template-columns: 1fr;
    align-content: center;
    padding: 24px;
  }

  .actions,
  .action {
    width: 100%;
  }
}
</style>
