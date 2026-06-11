<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Archive, Cloud, Download, EyeOff, Image, RadioTower, ShieldCheck, Upload } from '@lucide/vue';
import NirA from '@/components/NirA.vue';
import { authStore } from '@/store/auth';
import { appName } from '@/store/app-meta';
import { apiPost, type ApiSuccess } from '@/utils/api';
import { formatBytes } from '@/utils/byte-size';

type PublicPlan = ApiSuccess<'/api/billing/list-public-plans'>['data'][number];
type PublicPlanPrice = PublicPlan['prices'][number];
type PublicPlanPriceDeployment = PublicPlanPrice['deployments'][number];
type FeatureItem = {
	title: string;
	description: string;
	icon: typeof Cloud;
	to?: string;
};
type CurrencyOption = {
	assetId: string;
	symbol: string;
	name: string;
};

const plans = ref<PublicPlan[]>([]);
const selectedCurrencyAssetId = ref('');
const loadingPlans = ref(true);
const error = ref('');

const featureItems: FeatureItem[] = [
	{
		title: 'Workers + R2で軽く配信',
		description: 'Cloudflare Workers と R2 を使い、アップロードしたファイルをそのまま公開・共有できます。',
		icon: Cloud,
	},
	{
		title: 'tar.gzの中身も扱える',
		description: 'BGZFを使ったアーカイブ配信に対応し、必要なファイルだけを取り出しやすくします。',
		icon: Archive,
	},
	{
		title: 'ダウンロードと公開範囲を管理',
		description: 'アクセストークン、広告表示、ダウンロード数など、公開後の運用に必要な制御を備えています。',
		icon: ShieldCheck,
	},
	{
		title: 'ActivityPubから照会',
		description: '表示設定を有効にした公開ファイルは、対応サービスからリンクを照会できる形式で公開されます。',
		icon: RadioTower,
	},
	{
		title: '画像・動画縮小ツール',
		description: 'ブラウザ内で画像や動画を縮小し、アップロード前に保存できます。',
		icon: Image,
		to: '/tools/media-compress',
	},
];

const planList = computed(() => [...plans.value].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)));
const currencyOptions = computed<CurrencyOption[]>(() => {
	const map = new Map<string, CurrencyOption>();
	for (const plan of plans.value) {
		for (const price of plan.prices) {
			if (!map.has(price.assetId)) {
				map.set(price.assetId, {
					assetId: price.assetId,
					symbol: price.assetSymbol,
					name: price.assetName,
				});
			}
		}
	}
	return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.name.localeCompare(b.name));
});
const selectedCurrencyDeployments = computed<PublicPlanPriceDeployment[]>(() => {
	const map = new Map<string, PublicPlanPriceDeployment>();
	for (const plan of plans.value) {
		for (const price of plan.prices) {
			if (price.assetId !== selectedCurrencyAssetId.value) continue;
			for (const deployment of price.deployments) {
				map.set(`${deployment.chainId}:${deployment.tokenSymbol}`, deployment);
			}
		}
	}
	return [...map.values()].sort((a, b) => (
		a.chainName.localeCompare(b.chainName)
		|| a.tokenSymbol.localeCompare(b.tokenSymbol)
	));
});

async function loadPlans(): Promise<void> {
	loadingPlans.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/billing/list-public-plans');
		if (!result.ok) {
			error.value = result.data.message || 'プラン一覧の取得に失敗しました';
			return;
		}
		plans.value = result.data;
		if (
			selectedCurrencyAssetId.value === ''
			|| !currencyOptions.value.some(option => option.assetId === selectedCurrencyAssetId.value)
		) {
			selectedCurrencyAssetId.value = currencyOptions.value[0]?.assetId ?? '';
		}
	} catch (e) {
		error.value = String(e);
	} finally {
		loadingPlans.value = false;
	}
}

function formatQuota(value: number | null, formatter: (value: number) => string = value => value.toLocaleString()): string {
	return value == null ? '無制限' : formatter(value);
}

function adLabel(plan: PublicPlan): string {
	if (!plan.showAds) return '広告なし';
	return plan.canDisableFileAds ? 'ファイルごとに広告を無効化可能' : '広告表示あり';
}

function durationSortValue(value: number, unit: PublicPlanPrice['durationUnit']): number {
	const date = new Date(Date.UTC(2024, 0, 1));
	if (unit === 'days') date.setUTCDate(date.getUTCDate() + value);
	if (unit === 'months') date.setUTCMonth(date.getUTCMonth() + value);
	if (unit === 'years') date.setUTCFullYear(date.getUTCFullYear() + value);
	return date.getTime();
}

function compareBigIntString(a: string, b: string): number {
	const aValue = BigInt(a);
	const bValue = BigInt(b);
	return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
}

function cheapestPrice(plan: PublicPlan): PublicPlanPrice | null {
	const prices = plan.prices.filter(price => price.assetId === selectedCurrencyAssetId.value);
	return [...prices].sort((a, b) => (
		compareBigIntString(a.amountBaseUnits, b.amountBaseUnits)
		|| durationSortValue(a.durationDays, a.durationUnit) - durationSortValue(b.durationDays, b.durationUnit)
	))[0] ?? null;
}

function formatAmountValue(amountBaseUnits: string, decimals: number): string {
	const padded = amountBaseUnits.padStart(decimals + 1, '0');
	const integer = padded.slice(0, -decimals);
	const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
	const raw = integer + (fraction ? `.${fraction}` : '');
	const numeric = Number(raw);
	if (!Number.isFinite(numeric) || numeric === 0) return raw;
	return numeric.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}

function formatDuration(value: number, unit: PublicPlanPrice['durationUnit']): string {
	const label = unit === 'days' ? '日' : unit === 'months' ? 'ヶ月' : '年';
	return `${value}${label}`;
}

function priceLabel(plan: PublicPlan): string {
	const price = cheapestPrice(plan);
	if (!price) return '価格未設定';
	return `${formatAmountValue(price.amountBaseUnits, price.decimals)} ${price.assetSymbol} / ${formatDuration(price.durationDays, price.durationUnit)} から`;
}

onMounted(loadPlans);
</script>

<template>
  <main :class="$style.page">
    <section :class="$style.hero">
      <div :class="$style.heroContent">
        <div :class="$style.heroCopy">
          <p :class="$style.kicker">{{ appName }}</p>
          <h1>ファイルを置いて、必要な形で届ける</h1>
          <p :class="$style.lead">
            Cloudflare Workers、R2、D1で動くファイルアップローダー。小さな共有から、アーカイブの中身を扱う公開配信まで支えます。
          </p>
          <div :class="$style.heroActions">
            <NirA v-if="authStore.user" to="/my/buckets" class="btn btn-primary btn-lg">
              <Upload :size="18" :stroke-width="2" />マイバケットへ
            </NirA>
            <template v-else>
              <NirA to="/signin" class="btn btn-primary btn-lg">サインイン</NirA>
              <NirA to="/signup" class="btn btn-secondary btn-lg">サインアップ</NirA>
            </template>
          </div>
        </div>
        <div :class="$style.heroVisual" aria-hidden="true">
          <img src="/icon.any-512.png" alt="">
          <div :class="$style.heroStats">
            <span><Upload :size="16" :stroke-width="2" />Upload</span>
            <span><Download :size="16" :stroke-width="2" />Share</span>
            <span><EyeOff :size="16" :stroke-width="2" />Control</span>
          </div>
        </div>
      </div>
    </section>

    <section :class="$style.section">
      <div :class="$style.sectionHeader">
        <h2>できること</h2>
      </div>
      <div :class="$style.featureGrid">
        <article v-for="feature in featureItems" :key="feature.title" class="card" :class="$style.featureCard">
          <component :is="feature.icon" :size="22" :stroke-width="2" :class="$style.featureIcon" />
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
          <NirA v-if="feature.to" :to="feature.to" class="btn btn-secondary" :class="$style.featureAction">開く</NirA>
        </article>
      </div>
    </section>

    <section :class="$style.section">
      <div :class="$style.sectionHeader">
        <div>
          <h2>プラン</h2>
          <div v-if="currencyOptions.length > 0" :class="$style.currencyToggle" role="group" aria-label="表示通貨">
            <button
              v-for="currency in currencyOptions"
              :key="currency.assetId"
              type="button"
              :class="[$style.currencyButton, selectedCurrencyAssetId === currency.assetId ? $style.currencyButtonActive : null]"
              @click="selectedCurrencyAssetId = currency.assetId"
            >
              {{ currency.symbol }}
            </button>
          </div>
          <div v-if="selectedCurrencyDeployments.length > 0" :class="$style.deploymentList" aria-label="対応コインとチェーン">
            <span
              v-for="deployment in selectedCurrencyDeployments"
              :key="`${deployment.chainId}:${deployment.tokenSymbol}`"
              :class="$style.deploymentBadge"
            >
              <strong>{{ deployment.tokenSymbol }}</strong>
              <span>{{ deployment.chainName }}</span>
            </span>
          </div>
        </div>
        <NirA v-if="authStore.user" to="/my/payments" class="btn btn-secondary">購入・支払い管理</NirA>
      </div>

      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="loadingPlans" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>
      <div v-else-if="planList.length === 0" class="empty-state">
        <p>公開中のプランはありません。</p>
      </div>
      <div v-else :class="$style.planGrid">
        <article v-for="plan in planList" :key="plan.id" class="card" :class="$style.planCard">
          <div :class="$style.planHeader">
            <h3>{{ plan.name }}</h3>
            <p :class="$style.planPrice">{{ priceLabel(plan) }}</p>
            <span :class="['badge', plan.showAds ? 'badge-muted' : 'badge-success']">{{ adLabel(plan) }}</span>
          </div>
          <dl :class="$style.planDetails">
            <div>
              <dt>バケット数</dt>
              <dd>{{ formatQuota(plan.maxBuckets) }}</dd>
            </div>
            <div>
              <dt>バケット容量</dt>
              <dd>{{ formatQuota(plan.maxBucketSizeBytes, formatBytes) }}</dd>
            </div>
            <div>
              <dt>ファイル数</dt>
              <dd>{{ formatQuota(plan.maxFilesPerBucket) }}</dd>
            </div>
            <div>
              <dt>1日のアップロード</dt>
              <dd>{{ formatQuota(plan.maxDailyUploads) }}</dd>
            </div>
            <div>
              <dt>DL数表示</dt>
              <dd>{{ plan.canUseDownloadCount ? '利用可能' : 'なし' }}</dd>
            </div>
          </dl>
          <NirA v-if="authStore.user" to="/my/payments" class="btn btn-primary" :class="$style.planAction">購入へ</NirA>
        </article>
      </div>
    </section>
  </main>
</template>

<style module lang="scss">
.page {
  display: grid;
  gap: 36px;
}

.hero {
  --hero-text: var(--color-text);
  --hero-muted: var(--color-text-muted);
  --hero-kicker: var(--color-primary);

  width: 100vw;
  margin: -28px calc(50% - 50vw) 0;
  color: var(--hero-text);
  background: linear-gradient(180deg, var(--color-surface) 0%, var(--color-bg) 100%);
}

:global([data-theme="dark"]) .hero {
  --hero-text: #ffffff;
  --hero-muted: rgba(255, 255, 255, 0.86);
  --hero-kicker: rgba(255, 255, 255, 0.78);

  background: #111827;
}

.heroContent {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
  gap: 28px;
  align-items: center;
  max-width: 1200px;
  min-height: min(560px, calc(100vh - 118px));
  margin: 0 auto;
  padding: 64px 20px 56px;
}

.heroCopy {
  max-width: 700px;
}

.kicker {
  margin: 0 0 10px;
  color: var(--hero-kicker);
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero h1 {
  max-width: 720px;
  margin: 0;
  font-size: 3rem;
  line-height: 1.12;
}

.lead {
  max-width: 640px;
  margin: 18px 0 0;
  color: var(--hero-muted);
  font-size: 1.05rem;
}

.heroActions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 28px;
}

.heroVisual {
  position: relative;
  display: grid;
  gap: 16px;
  justify-items: center;
  min-width: 0;
  padding: 24px 0 18px;
}

.heroVisual img {
  position: relative;
  z-index: 1;
  width: min(220px, 58vw);
  aspect-ratio: 1;
  object-fit: contain;
  filter: drop-shadow(0 24px 44px rgba(0, 0, 0, 0.34));
}

.heroStats {
  position: relative;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
  max-width: min(360px, 100%);
  margin-top: 2px;
}

.heroStats span {
  --badge-bg: #e0f2fe;
  --badge-border: #7dd3fc;
  --badge-text: #075985;
  --badge-shadow: rgba(2, 132, 199, 0.2);

  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--badge-border);
  border-radius: 999px;
  background: var(--badge-bg);
  color: var(--badge-text);
  font-size: 0.8125rem;
  font-weight: 600;
  box-shadow:
    0 12px 24px var(--badge-shadow),
    0 2px 8px rgba(15, 23, 42, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(14px) saturate(1.15);
}

.heroStats span:nth-child(1) {
  --badge-bg: #dcfce7;
  --badge-border: #86efac;
  --badge-text: #166534;
  --badge-shadow: rgba(22, 163, 74, 0.18);

  transform: rotate(-1.5deg);
}

.heroStats span:nth-child(2) {
  --badge-bg: #dbeafe;
  --badge-border: #93c5fd;
  --badge-text: #1d4ed8;
  --badge-shadow: rgba(37, 99, 235, 0.18);

  transform: translateY(8px);
}

.heroStats span:nth-child(3) {
  --badge-bg: #fae8ff;
  --badge-border: #e879f9;
  --badge-text: #86198f;
  --badge-shadow: rgba(192, 38, 211, 0.18);

  transform: rotate(1.5deg);
}

:global([data-theme="dark"]) .heroStats span {
  box-shadow:
    0 14px 28px rgba(0, 0, 0, 0.3),
    0 2px 8px rgba(0, 0, 0, 0.22),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
}

:global([data-theme="dark"]) .heroStats span:nth-child(1) {
  --badge-bg: rgba(22, 101, 52, 0.72);
  --badge-border: rgba(134, 239, 172, 0.42);
  --badge-text: #dcfce7;
}

:global([data-theme="dark"]) .heroStats span:nth-child(2) {
  --badge-bg: rgba(30, 64, 175, 0.72);
  --badge-border: rgba(147, 197, 253, 0.42);
  --badge-text: #dbeafe;
}

:global([data-theme="dark"]) .heroStats span:nth-child(3) {
  --badge-bg: rgba(134, 25, 143, 0.72);
  --badge-border: rgba(232, 121, 249, 0.42);
  --badge-text: #fae8ff;
}

.section {
  display: grid;
  gap: 16px;
}

.sectionHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sectionHeader h2 {
  margin: 0;
  font-size: 1.375rem;
}

.currencyToggle {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.currencyButton {
  min-width: 52px;
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 700;
  cursor: pointer;
}

.currencyButton:hover {
  background: var(--color-bg);
  color: var(--color-text);
}

.currencyButtonActive {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: #ffffff;
}

.currencyButtonActive:hover {
  background: var(--color-primary-hover);
  color: #ffffff;
}

.deploymentList {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.deploymentBadge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, var(--color-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 9%, var(--color-surface));
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.2;
}

.deploymentBadge strong {
  color: var(--color-text);
  font-weight: 700;
}

.deploymentBadge span {
  overflow-wrap: anywhere;
}

.featureGrid,
.planGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.featureCard {
  display: flex;
  flex-direction: column;
  max-width: none;
}

.featureIcon {
  color: var(--color-primary);
  margin-bottom: 12px;
}

.featureCard h3,
.planCard h3 {
  font-size: 1.05rem;
}

.featureCard p {
  margin-bottom: 14px;
  color: var(--color-text-muted);
}

.featureAction {
  margin-top: auto;
  align-self: flex-start;
}

.planCard {
  display: flex;
  flex-direction: column;
  max-width: none;
  min-height: 100%;
}

.planHeader {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}

.planHeader h3 {
  margin: 0;
}

.planPrice {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
}

.planDetails {
  display: grid;
  gap: 10px;
  margin: 0;
}

.planDetails div {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.planDetails dt {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.planDetails dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 600;
}

.planAction {
  align-self: stretch;
  margin-top: auto;
}

.planDetails + .planAction {
  margin-top: 18px;
}

@media (max-width: 780px) {
  .heroContent {
    grid-template-columns: 1fr;
    min-height: auto;
    padding-top: 48px;
  }

  .hero h1 {
    font-size: 2.25rem;
  }

  .heroVisual {
    justify-items: start;
  }
}

@media (max-width: 520px) {
  .hero h1 {
    font-size: 2rem;
  }

  .sectionHeader {
    align-items: flex-start;
    flex-direction: column;
  }

  .planDetails div {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
