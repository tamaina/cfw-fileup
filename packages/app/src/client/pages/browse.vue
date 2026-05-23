<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { FileVisibility } from '../../shared/file-visibility';
import { Form, Input } from '@vuetify/v0';
import BrowseDirectory from './browse.directory.vue';
import BrowseFile from './browse.file.vue';
import BrowseFileTokens from './browse.file-tokens.vue';
import TurnstileWidget from '@/components/turnstile-widget.vue';
import MarkdownPreview from '@/components/markdown-preview.vue';
import RawTextPreview from '@/components/raw-text-preview.vue';
import JsonPreview from '@/components/json-preview.vue';
import NirA from '@/components/nira.vue';
import { authStore, authHeaders, updateTermsAgreedAt } from '@/store/auth';
import { apiPost } from '@/utils/api';
import { mainRouter } from '@/router';
import { Nirax, type RouteDef } from '@/nirax';

const props = withDefaults(defineProps<{
	bucketName: string;
	filePath?: string;
}>(), { filePath: '' });

const archiveEntryMount = '/:entries';
const archiveEntryRouteDef = [
	{
		path: '/:entryPath(*)?',
		component: BrowseDirectory,
	},
] as const satisfies RouteDef[];

function resolveArchiveEntryRoute(path: string): string {
	const router = new Nirax(archiveEntryRouteDef, path, false, BrowseDirectory);
	const entryPath = router.current.props.get('entryPath');
	return typeof entryPath === 'string' ? entryPath : '';
}

const archiveRoute = computed(() => {
	const markerIndex = props.filePath.indexOf(archiveEntryMount);
	if (markerIndex === -1) {
		return { baseFilePath: props.filePath, entryPath: null };
	}
	const entryRoutePath = props.filePath.slice(markerIndex + archiveEntryMount.length) || '/';
	return {
		baseFilePath: props.filePath.slice(0, markerIndex),
		entryPath: resolveArchiveEntryRoute(entryRoutePath),
	};
});

const baseFilePath = computed(() => {
	return archiveRoute.value.baseFilePath;
});

const entryPath = computed(() => {
	return archiveRoute.value.entryPath;
});
const queryToken = computed(() => {
	const qs = mainRouter.currentRef.value?._parsedRoute?.queryString;
	if (!qs) return null;
	return new URLSearchParams(qs).get('token');
});

const isEntryFile = computed(() => entryPath.value !== null && !entryPath.value.endsWith('/'));
const isEntryDirectory = computed(() => entryPath.value !== null && entryPath.value.endsWith('/'));

const innerMeta = ref<{ mimeType: string; size?: number } | null>(null);

const innerDownloadUrl = computed(() => {
	if (!fileId.value) return '';
	const base = `/d/${fileId.value}/${encodeURIComponent(':entries')}/${encodeURIComponent(entryPath.value ?? '')}`;
	return autoToken.value ? `${base}?token=${autoToken.value}` : base;
});

const isInnerImage = computed(() => {
	const mime = innerMeta.value?.mimeType ?? '';
	if (mime.startsWith('image/')) return true;
	const ext = entryPath.value?.split('.').pop()?.toLowerCase() ?? '';
	return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext);
});

const isInnerMarkdown = computed(() => {
	const mime = innerMeta.value?.mimeType ?? '';
	if (mime === 'text/markdown') return true;
	const lower = entryPath.value?.toLowerCase() ?? '';
	return lower.endsWith('.md') || lower.endsWith('.markdown');
});
const isInnerJson = computed(() => {
	const mime = innerMeta.value?.mimeType ?? '';
	if (mime === 'application/json' || mime.endsWith('+json')) return true;
	const lower = entryPath.value?.toLowerCase() ?? '';
	return /\.(?:json|jsonl|geojson)$/.test(lower);
});
const isInnerTextLike = computed(() => {
	const mime = innerMeta.value?.mimeType ?? '';
	if (mime.startsWith('text/')) return true;
	if (/(?:^|\/)(?:json|xml|javascript|typescript|csv|yaml|x-yaml)$/.test(mime)) return true;
	const lower = entryPath.value?.toLowerCase() ?? '';
	return /\.(?:txt|md|markdown|json|csv|ts|js|mjs|jsx|tsx|vue|css|scss|html|xml|ya?ml|c|cc|cpp|cs|go|h|hpp|java|kt|php|py|rb|rs|sh|sql|svelte|swift)$/.test(lower);
});

const breadcrumbs = computed(() => {
	const parts = baseFilePath.value ? baseFilePath.value.replace(/\/$/, '').split('/') : [];
	const result: { name: string; link: string | null }[] = [];
	const hasEntry = entryPath.value !== null;

	result.push({
		name: props.bucketName,
		link: parts.length === 0 && !hasEntry ? null : `/v/${props.bucketName}/`,
	});

	for (let i = 0; i < parts.length; i++) {
		const isLast = i === parts.length - 1;
		const pathSoFar = parts.slice(0, i + 1).join('/') + '/';
		result.push({
			name: parts[i],
			link: isLast && !hasEntry
				? null
				: isLast && hasEntry
					? `/v/${props.bucketName}/${parts.slice(0, i + 1).join('/')}`
					: `/v/${props.bucketName}/${pathSoFar}`,
		});
	}

	if (hasEntry && entryPath.value) {
		const innerParts = entryPath.value.replace(/\/$/, '').split('/').filter(Boolean);
		for (let i = 0; i < innerParts.length; i++) {
			const isLast = i === innerParts.length - 1;
			const innerSoFar = innerParts.slice(0, i + 1).join('/');
			result.push({
				name: innerParts[i],
				link: isLast ? null : `/v/${props.bucketName}/${baseFilePath.value}/${encodeURIComponent(':entries')}/${encodeURIComponent(innerSoFar + '/')}`,
			});
		}
	}

	return result;
});

const isDirectory = computed(() => entryPath.value === null && (baseFilePath.value === '' || baseFilePath.value.endsWith('/')));

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const isTargz = ref(false);
const isTar = ref(false);
const fileSize = ref<number | null>(null);
const fileId = ref<string | null>(null);
const fileBucketId = ref<string | null>(null);
const fileMimeType = ref<string | null>(null);
const fileExtensionMimeType = ref<string | null>(null);
const hasMimeTypeMismatch = ref(false);
const hasExecutableContent = ref(false);
const browseTermsLoading = ref(false);
const browseTermsUrl = ref('');
const browseTermsAccepted = ref(false);
const browseTermsError = ref('');
const metaLoading = ref(false);
const metaError = ref('');
const fileVisibility = ref<FileVisibility>('public');

const activeTab = ref<'info' | 'tokens'>('info');
const autoToken = ref<string | null>(null);
const autoTokenId = ref<string | null>(null);
const autoTokenLoading = ref(false);
let autoTokenPromise: Promise<void> | null = null;

const turnstileEnabled = ref(false);
const turnstileSiteKey = ref('');
const passphraseInput = ref('');
const passphraseError = ref('');
const passphraseLoading = ref(false);
const turnstileToken = ref<string | null>(null);
const passphraseTokenExpiresAt = ref<number | null>(null);
let tokenExpiryTimer: ReturnType<typeof setTimeout> | null = null;

const passphraseTokenExpiryStr = computed(() => {
	if (!passphraseTokenExpiresAt.value) return '';
	return new Date(passphraseTokenExpiresAt.value - 60_000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
});

const needsPassphrase = computed(() =>
	!browseTermsBlocked.value && !isDirectory.value && !authStore.user && fileVisibility.value === 'passphrase' && !autoToken.value && !metaLoading.value && !metaError.value,
);
const detailsLoading = computed(() =>
	browseTermsLoading.value || metaLoading.value || (activeTab.value === 'info' && authStore.user && !isDirectory.value && fileVisibility.value !== 'public' && autoTokenLoading.value),
);
const browseTermsUpdatedAt = ref('');
const currentBrowseUrl = computed(() => {
	const parsed = mainRouter.currentRef.value?._parsedRoute;
	if (!parsed) return location.href;
	return `${location.origin}${parsed.fullPath}`;
});
const isTermsPage = computed(() => {
	if (!browseTermsUrl.value) return false;
	try {
		const termsUrl = new URL(browseTermsUrl.value, location.origin);
		const currentUrl = new URL(currentBrowseUrl.value);
		return termsUrl.origin === currentUrl.origin &&
			currentUrl.pathname.startsWith(termsUrl.pathname) &&
			(!termsUrl.search || currentUrl.search === termsUrl.search);
	} catch {
		return false;
	}
});
const browseTermsRequiredAt = computed(() => {
	if (!browseTermsUrl.value) return 0;
	if (!browseTermsUpdatedAt.value) return 1;
	const time = Date.parse(`${browseTermsUpdatedAt.value}T00:00:00.000Z`);
	return Number.isNaN(time) ? 1 : time;
});
const browseTermsBlocked = computed(() => !authStore.user && browseTermsUrl.value !== '' && !isTermsPage.value && !browseTermsAccepted.value);

const browseTermsStorageKey = 'cfw-fileup:browse-terms-agreed-at';

function loadAnonymousBrowseTermsAgreedAt(): number | null {
	try {
		const raw = localStorage.getItem(browseTermsStorageKey);
		if (!raw) return null;
		const agreedAt = Number(raw);
		return Number.isFinite(agreedAt) ? agreedAt : null;
	} catch {
		return null;
	}
}

function hasAcceptedBrowseTerms(): boolean {
	const requiredAt = browseTermsRequiredAt.value;
	if (requiredAt === 0) return true;
	const agreedAt = authStore.user
		? authStore.user.termsAgreedAt
		: loadAnonymousBrowseTermsAgreedAt();
	return agreedAt !== null && agreedAt >= requiredAt;
}

async function acceptBrowseTerms(): Promise<void> {
	const agreedAt = Date.now();
	if (authStore.user) {
		const result = await apiPost('/api/account/agree-terms', { agreedAt });
		if (!result.ok) {
			browseTermsError.value = result.data.message ?? '利用規約への同意を保存できませんでした';
			return;
		}
		updateTermsAgreedAt(result.data.termsAgreedAt);
	} else {
		try {
			localStorage.setItem(browseTermsStorageKey, String(agreedAt));
		} catch { /* */ }
	}
	browseTermsAccepted.value = true;
	fetchMeta();
}

async function fetchBrowseTerms(): Promise<void> {
	browseTermsLoading.value = true;
	browseTermsError.value = '';
	try {
		const res = await fetch('/api/meta');
		if (!res.ok) {
			browseTermsError.value = `利用規約の取得に失敗しました: ${res.status}`;
			return;
		}
		const data = await res.json() as { termsUrl?: string; termsUpdatedAt?: string };
		browseTermsUrl.value = data.termsUrl ?? '';
		browseTermsUpdatedAt.value = data.termsUpdatedAt ?? '';
		browseTermsAccepted.value = hasAcceptedBrowseTerms();
		if (!browseTermsBlocked.value) fetchMeta();
	} catch (e) {
		browseTermsError.value = String(e);
	} finally {
		browseTermsLoading.value = false;
	}
}

async function fetchInnerMeta(): Promise<void> {
	if (!isEntryFile.value || !entryPath.value || !fileId.value) return;
	const tokenParam = autoToken.value ? `&token=${autoToken.value}` : '';
	const url = `/d/${fileId.value}?list=${encodeURIComponent(entryPath.value)}${tokenParam}`;
	try {
		const res = await fetch(url, { headers: authHeaders() });
		if (!res.ok) return;
		const data = await res.json() as Array<{ path: string; mimeType: string; size?: number }>;
		const entry = data.find(e => e.path === entryPath.value);
		innerMeta.value = entry ? { mimeType: entry.mimeType, size: entry.size } : null;
	} catch { /* silent */ }
}

async function fetchMeta(): Promise<void> {
	if (browseTermsBlocked.value) return;
	if (isDirectory.value) {
		isTargz.value = false;
		fileMimeType.value = null;
		fileExtensionMimeType.value = null;
		hasMimeTypeMismatch.value = false;
		hasExecutableContent.value = false;
		return;
	}
	metaLoading.value = true;
	metaError.value = '';
	innerMeta.value = null;
	fileId.value = null;
	fileBucketId.value = null;
	try {
		const metaUrl = new URL('/api/files/meta', location.origin);
		metaUrl.searchParams.set('bucketName', props.bucketName);
		metaUrl.searchParams.set('path', baseFilePath.value);
		if (queryToken.value) metaUrl.searchParams.set('token', queryToken.value);
		const [metaRes, apiMetaRes] = await Promise.all([
			fetch(metaUrl, { headers: authHeaders() }),
			fetch('/api/meta'),
		]);
		if (!metaRes.ok) { metaError.value = `取得失敗: ${metaRes.status}`; return; }
		const data = await metaRes.json() as {
			isTargz?: boolean;
			isTar?: boolean;
			visibility?: FileVisibility;
			size?: number;
			mimeType?: string | null;
			extensionMimeType?: string;
			hasMimeTypeMismatch?: boolean;
			hasExecutableContent?: boolean;
			fileId?: string;
			bucketId?: string;
		};
		isTargz.value = data.isTargz ?? false;
		isTar.value = data.isTar ?? false;
		fileSize.value = data.size ?? null;
		fileMimeType.value = data.mimeType ?? null;
		fileExtensionMimeType.value = data.extensionMimeType ?? null;
		hasMimeTypeMismatch.value = data.hasMimeTypeMismatch ?? false;
		hasExecutableContent.value = data.hasExecutableContent ?? false;
		fileVisibility.value = data.visibility ?? 'public';
		fileId.value = data.fileId ?? null;
		fileBucketId.value = data.bucketId ?? null;

		if (apiMetaRes.ok) {
			const apiMeta = await apiMetaRes.json() as { turnstileEnabled?: boolean; turnstileSiteKey?: string };
			turnstileEnabled.value = apiMeta.turnstileEnabled ?? false;
			turnstileSiteKey.value = apiMeta.turnstileSiteKey ?? '';
		}

		if (queryToken.value && data.fileId) {
			autoToken.value = queryToken.value;
		} else if (fileVisibility.value !== 'public') {
			if (authStore.user) {
				await issueAutoToken();
			} else {
				// キャッシュ済み合言葉トークンを復元
				const cached = loadCachedToken();
				if (cached) {
					autoToken.value = cached.token;
					passphraseTokenExpiresAt.value = cached.expiresAt;
					scheduleTokenExpiry(cached.expiresAt);
					if (cached.fileId) fileId.value = cached.fileId;
				}
			}
		}
		if (isEntryFile.value) {
			await fetchInnerMeta();
		}
	} catch (e) {
		metaError.value = String(e);
	} finally {
		metaLoading.value = false;
	}
}

async function submitPassphrase({ valid }: { valid: boolean }): Promise<void> {
	if (!valid) return;
	passphraseError.value = '';
	passphraseLoading.value = true;
	try {
		const result = await apiPost('/api/file-tokens/create-by-passphrase', {
			bucketName: props.bucketName,
			filePath: baseFilePath.value,
			passphrase: passphraseInput.value,
			turnstileToken: turnstileEnabled.value && turnstileToken.value ? turnstileToken.value : undefined,
		});
		if (!result.ok) {
			passphraseError.value = result.data.message || `エラー: ${result.status}`;
			return;
		}
		autoToken.value = result.data.token;
		autoTokenId.value = result.data.id;
		passphraseTokenExpiresAt.value = result.data.expiresAt;
		fileId.value = result.data.fileId;
		saveCachedToken(result.data.token, result.data.expiresAt, result.data.id, result.data.fileId);
		scheduleTokenExpiry(result.data.expiresAt);
		passphraseInput.value = '';
		turnstileToken.value = null;
		await fetchInnerMeta();
	} catch (e) {
		passphraseError.value = String(e);
	} finally {
		passphraseLoading.value = false;
	}
}

function autoTokenCacheKey(): string {
	return `autoToken:${props.bucketName}/${baseFilePath.value}`;
}

function clearExpiryTimer(): void {
	if (tokenExpiryTimer !== null) {
		clearTimeout(tokenExpiryTimer);
		tokenExpiryTimer = null;
	}
}

function expireToken(): void {
	autoToken.value = null;
	autoTokenId.value = null;
	passphraseTokenExpiresAt.value = null;
	tokenExpiryTimer = null;
	try { sessionStorage.removeItem(autoTokenCacheKey()); } catch { /* */ }
}

function scheduleTokenExpiry(expiresAt: number | null): void {
	clearExpiryTimer();
	if (expiresAt === null) return;
	const delay = expiresAt - Date.now() - 60_000;
	if (delay <= 0) { expireToken(); return; }
	tokenExpiryTimer = setTimeout(expireToken, delay);
}

function loadCachedToken(): { id: string | null; token: string; expiresAt: number | null; fileId?: string } | null {
	try {
		const raw = sessionStorage.getItem(autoTokenCacheKey());
		if (!raw) return null;
		const cached = JSON.parse(raw) as { id?: string | null; token: string; expiresAt: number | null; fileId?: string };
		// 60秒バッファを持たせて期限チェック
		if (cached.expiresAt !== null && cached.expiresAt < Date.now() + 60_000) return null;
		return { id: cached.id ?? null, token: cached.token, expiresAt: cached.expiresAt, fileId: cached.fileId };
	} catch { return null; }
}

function saveCachedToken(token: string, expiresAt: number | null, id: string | null, fileId?: string): void {
	try {
		sessionStorage.setItem(autoTokenCacheKey(), JSON.stringify({ id, token, expiresAt, fileId }));
	} catch { /* quota exceeded etc. */ }
}

async function issueAutoToken(): Promise<void> {
	const cached = loadCachedToken();
	if (cached) {
		autoToken.value = cached.token;
		autoTokenId.value = cached.id;
		return;
	}
	if (autoTokenPromise) return autoTokenPromise;
	const requestKey = autoTokenCacheKey();
	autoToken.value = null;
	autoTokenId.value = null;
	autoTokenLoading.value = true;
	autoTokenPromise = (async () => {
		const result = await apiPost('/api/file-tokens/create', { bucketName: props.bucketName, filePath: baseFilePath.value, expiresIn: 3600 });
		if (result.ok && requestKey === autoTokenCacheKey()) {
			autoToken.value = result.data.token;
			autoTokenId.value = result.data.id;
			saveCachedToken(result.data.token, result.data.expiresAt, result.data.id);
		}
	})().catch(() => { /* silent */ }).finally(() => {
		if (requestKey === autoTokenCacheKey()) {
			autoTokenLoading.value = false;
			autoTokenPromise = null;
		}
	});
	return autoTokenPromise;
}

function infoTabClicked() {
	activeTab.value = 'info';
	if (fileVisibility.value !== 'public') issueAutoToken();
}

function fileVisibilityChanged(v: FileVisibility) {
	fileVisibility.value = v;
	if (v !== 'public' && authStore.user) issueAutoToken();
}

function tokenDeleted(tokenId: string) {
	if (autoTokenId.value !== tokenId) return;
	autoToken.value = null;
	autoTokenId.value = null;
	try { sessionStorage.removeItem(autoTokenCacheKey()); } catch { /* */ }
}

onMounted(fetchBrowseTerms);
watch(() => [props.bucketName, props.filePath], () => {
	activeTab.value = 'info';
	autoToken.value = null;
	autoTokenId.value = null;
	autoTokenLoading.value = false;
	autoTokenPromise = null;
	passphraseTokenExpiresAt.value = null;
	fileId.value = null;
	fileBucketId.value = null;
	fileMimeType.value = null;
	fileExtensionMimeType.value = null;
	hasMimeTypeMismatch.value = false;
	hasExecutableContent.value = false;
	clearExpiryTimer();
	fetchBrowseTerms();
});
onUnmounted(clearExpiryTimer);
watch(() => [entryPath.value, queryToken.value], () => {
	innerMeta.value = null;
	if (queryToken.value !== autoToken.value) {
		fetchBrowseTerms();
		return;
	}
	if (!browseTermsBlocked.value && isEntryFile.value) fetchInnerMeta();
});
</script>

<template>
  <div>
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <nav class="breadcrumbs" :class="$style.breadcrumbsNoMargin">
        <template v-for="(seg, i) in breadcrumbs" :key="i">
          <span v-if="i > 0" class="breadcrumbs-sep">/</span>
          <NirA v-if="seg.link" :to="seg.link">{{ seg.name }}</NirA>
          <span v-else class="breadcrumbs-current">{{ seg.name }}</span>
        </template>
      </nav>
      <span
        v-if="!isDirectory && !metaLoading && !metaError"
        :class="fileVisibility === 'public' ? 'badge badge-success' : fileVisibility === 'passphrase' ? 'badge badge-warning' : 'badge badge-muted'"
      >
        {{ fileVisibility === 'public' ? '公開' : fileVisibility === 'passphrase' ? '合言葉' : '非公開' }}
      </span>
      <span
        v-if="!isDirectory && !metaLoading && !metaError && (isEntryFile ? innerMeta?.size != null : fileSize != null)"
        :class="'badge badge-muted'"
      >
        {{ formatSize((isEntryFile ? innerMeta?.size : fileSize) ?? 0) }}
      </span>
      <span v-if="passphraseTokenExpiresAt" class="badge badge-info" :title="`${passphraseTokenExpiryStr} まで有効`">
        合言葉認証済み（{{ passphraseTokenExpiryStr }} まで）
      </span>
    </div>

    <div v-if="detailsLoading" class="page-loading">
      <span class="spinner"></span>読み込み中...
    </div>
    <div v-else-if="browseTermsError" class="alert alert-error">{{ browseTermsError }}</div>
    <div v-else-if="browseTermsBlocked" class="card" :class="$style.termsGate">
      <h2 :class="['card-title', $style.termsGateTitle]">利用規約への同意が必要です</h2>
      <p :class="[$style.termsGateDesc, 'text-muted']">
        ファイルやディレクトリを表示する前に、利用規約を確認して同意してください。
      </p>
      <p v-if="browseTermsUpdatedAt" :class="[$style.termsGateDate, 'text-muted']">
        利用規約更新日: {{ browseTermsUpdatedAt }}
      </p>
      <div :class="$style.termsGateActions">
        <a :href="browseTermsUrl" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">利用規約を開く</a>
        <button type="button" class="btn btn-primary" @click="acceptBrowseTerms">同意して表示</button>
      </div>
    </div>
    <div v-else-if="metaError" class="alert alert-error">{{ metaError }}</div>
    <template v-else>
      <div v-if="!isDirectory && hasMimeTypeMismatch" :class="['alert', 'alert-warning', 'mb-3', $style.fileTypeWarning]">
        <p :class="$style.fileTypeWarningLine">ファイル名の拡張子と内容が一致していない可能性があります。</p>
        <p v-if="hasExecutableContent" :class="$style.fileTypeWarningLine">実行可能ファイルとして検出されています。</p>
        <p v-if="fileMimeType || fileExtensionMimeType" :class="$style.fileTypeWarningLine">内容: {{ fileMimeType ?? '不明' }} / 拡張子: {{ fileExtensionMimeType ?? '不明' }}</p>
      </div>

      <!-- アーカイブ内ファイルビュー (ログイン有無問わず) -->
      <template v-if="(isTargz || isTar) && isEntryFile">
        <div class="card file-actions">
          <a :href="innerDownloadUrl" download class="btn btn-primary">ダウンロード</a>
        </div>
        <div v-if="isInnerImage" :class="$style.innerImagePreview">
          <img :src="innerDownloadUrl" :alt="entryPath ?? ''" class="file-preview-image">
        </div>
        <MarkdownPreview v-else-if="isInnerMarkdown" :url="innerDownloadUrl" :filename="entryPath ?? ''" :class="$style.innerMarkdownPreview" />
        <JsonPreview v-else-if="isInnerJson" :url="innerDownloadUrl" :filename="entryPath ?? ''" :class="$style.innerJsonPreview" />
        <RawTextPreview v-else-if="isInnerTextLike" :url="innerDownloadUrl" :filename="entryPath ?? ''" :class="$style.innerRawPreview" />
      </template>

      <!-- ファイル・ログイン済み: タブ付きパネル -->
      <template v-else-if="!isDirectory && authStore.user">
        <div class="tab-bar mb-3">
          <button :class="['tab-btn', activeTab === 'info' ? 'tab-btn-active' : '']" @click="infoTabClicked">詳細</button>
          <button :class="['tab-btn', activeTab === 'tokens' ? 'tab-btn-active' : '']" @click="activeTab = 'tokens'">共有</button>
        </div>

        <!-- 詳細タブ: ファイル表示 -->
        <template v-if="activeTab === 'info'">
          <BrowseDirectory v-if="isTargz || isTar" :bucketName="bucketName" :filePath="baseFilePath" :isTargz="isTargz" :isTar="isTar" :entryPath="entryPath ?? ''" :token="autoToken ?? undefined" :fileId="fileId ?? undefined" />
          <BrowseFile v-else :bucketName="bucketName" :filePath="baseFilePath" :token="autoToken ?? undefined" :fileId="fileId ?? ''" :bucketId="fileBucketId" />
        </template>

        <!-- 共有タブ: 公開設定 + 共有URL管理 -->
        <BrowseFileTokens
          v-else-if="activeTab === 'tokens'"
          :bucketName="bucketName"
          :filePath="baseFilePath"
          :fileVisibility="fileVisibility"
          :autoTokenId="autoTokenId"
          @update:fileVisibility="fileVisibilityChanged"
          @tokenDeleted="tokenDeleted"
        />
      </template>

      <!-- 非ログイン + 非公開 + トークンなし: 合言葉フォーム -->
      <template v-else-if="needsPassphrase">
        <div class="card">
          <p :class="[$style.passphraseDesc, 'text-muted']">このファイルはプライベートです。合言葉を入力するとアクセスできます。</p>
          <Form :class="$style.passphraseForm" @submit="submitPassphrase">
            <div class="flex gap-2">
              <div :class="$style.passphraseInputWrapper">
                <label class="form-label">合言葉</label>
                <Input.Root v-model="passphraseInput" type="input" required validate-on="submit">
                  <Input.Control placeholder="合言葉" class="form-input" autocomplete="current-password" />
                  <Input.Error v-slot="{ errors }">
                    <span v-for="e in errors" :key="e" class="form-error">{{ e }}</span>
                  </Input.Error>
                </Input.Root>
              </div>
              <button
                type="submit"
                :class="[$style.passphraseSubmit, 'btn', 'btn-primary']"
                :disabled="passphraseLoading || (turnstileEnabled && !turnstileToken)"
              >{{ passphraseLoading ? '認証中...' : 'アクセス' }}</button>
            </div>
            <div v-if="passphraseError" class="alert alert-error">{{ passphraseError }}</div>
            <TurnstileWidget
              v-if="turnstileEnabled && turnstileSiteKey"
              :site-key="turnstileSiteKey"
              @update:token="turnstileToken = $event"
            />
          </Form>
        </div>
      </template>

      <!-- ログインなし or ディレクトリ or (非公開 + トークンあり): タブなし -->
      <template v-else>
        <BrowseDirectory v-if="isDirectory || isTargz || isTar" :bucketName="bucketName" :filePath="baseFilePath" :isTargz="isTargz" :isTar="isTar" :entryPath="entryPath ?? ''" :token="autoToken ?? undefined" :fileId="fileId ?? undefined" />
        <BrowseFile v-else-if="!isDirectory" :bucketName="bucketName" :filePath="baseFilePath" :token="autoToken ?? undefined" :fileId="fileId ?? ''" :bucketId="fileBucketId" />
      </template>
    </template>
  </div>
</template>

<style module lang="scss">
.breadcrumbsNoMargin {
  margin-bottom: 0;
}

.innerImagePreview {
  margin-top: 16px;
}

.innerMarkdownPreview {
  margin-top: 16px;
}

.innerJsonPreview {
  margin-top: 16px;
}

.innerRawPreview {
  margin-top: 16px;
}

.termsGate {
  max-width: 520px;
}

.termsGateTitle {
  margin: 0 0 8px;
}

.termsGateDesc {
  margin: 0 0 8px;
}

.termsGateDate {
  margin: 0 0 16px;
  font-size: 0.875rem;
}

.termsGateActions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.fileTypeWarning {
  display: block;
}

.fileTypeWarningLine {
  margin: 0;
}

.fileTypeWarningLine + .fileTypeWarningLine {
  margin-top: 4px;
}

.passphraseDesc {
  margin-bottom: 16px;
}

.passphraseForm {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 400px;
}

.passphraseInputWrapper {
  flex: 1;
  min-width: 0;
}

.passphraseSubmit {
  align-self: flex-end;
}
</style>
