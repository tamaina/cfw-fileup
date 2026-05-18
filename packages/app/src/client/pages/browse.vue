<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { Button, Form, Input } from '@vuetify/v0';
import BrowseDirectory from './browse.directory.vue';
import BrowseFile from './browse.file.vue';
import BrowseFileTokens from './browse.file-tokens.vue';
import TurnstileWidget from '@/components/turnstile-widget.vue';
import NirA from '@/components/nira.vue';
import { authStore, authHeaders } from '@/store/auth';
import { apiPost } from '@/utils/api';
import { mainRouter } from '@/router';

const props = withDefaults(defineProps<{
	bucketName: string;
	filePath?: string;
}>(), { filePath: '' });

const entryPath = computed(() => {
	const qs = mainRouter.currentRef.value?._parsedRoute?.queryString;
	if (!qs) return null;
	return new URLSearchParams(qs).get('file');
});

const isEntryFile = computed(() => entryPath.value !== null && !entryPath.value.endsWith('/'));
const isEntryDirectory = computed(() => entryPath.value !== null && entryPath.value.endsWith('/'));

const innerMeta = ref<{ mimeType: string; size?: number } | null>(null);

const innerDownloadUrl = computed(() => {
	const base = `/d/${props.bucketName}/${props.filePath}?file=${encodeURIComponent(entryPath.value ?? '')}`;
	return autoToken.value ? `${base}&token=${autoToken.value}` : base;
});

const isInnerImage = computed(() => {
	const mime = innerMeta.value?.mimeType ?? '';
	if (mime.startsWith('image/')) return true;
	const ext = entryPath.value?.split('.').pop()?.toLowerCase() ?? '';
	return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext);
});

const isInnerText = computed(() => {
	const mime = innerMeta.value?.mimeType ?? '';
	if (mime.startsWith('text/')) return true;
	const ext = entryPath.value?.split('.').pop()?.toLowerCase() ?? '';
	return ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'yaml', 'yml', 'toml', 'sh', 'csv'].includes(ext);
});

const breadcrumbs = computed(() => {
	const parts = props.filePath ? props.filePath.replace(/\/$/, '').split('/') : [];
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
				link: isLast ? null : `/v/${props.bucketName}/${props.filePath}?file=${encodeURIComponent(innerSoFar + '/')}`,
			});
		}
	}

	return result;
});

const isDirectory = computed(() => props.filePath === '' || props.filePath.endsWith('/'));

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const isTargz = ref(false);
const isTar = ref(false);
const fileSize = ref<number | null>(null);
const metaLoading = ref(false);
const metaError = ref('');
const fileIsPublic = ref(true);

const activeTab = ref<'info' | 'tokens'>('info');
const autoToken = ref<string | null>(null);

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
	!isDirectory.value && !authStore.user && !fileIsPublic.value && !autoToken.value && !metaLoading.value && !metaError.value,
);

async function fetchInnerMeta(): Promise<void> {
	if (!isEntryFile.value || !entryPath.value) return;
	const tokenParam = autoToken.value ? `&token=${autoToken.value}` : '';
	const url = `/d/${props.bucketName}/${props.filePath}?list=${encodeURIComponent(entryPath.value)}${tokenParam}`;
	try {
		const res = await fetch(url, { headers: authHeaders() });
		if (!res.ok) return;
		const data = await res.json() as Array<{ path: string; mimeType: string; size?: number }>;
		const entry = data.find(e => e.path === entryPath.value);
		innerMeta.value = entry ? { mimeType: entry.mimeType, size: entry.size } : null;
	} catch { /* silent */ }
}

async function fetchMeta(): Promise<void> {
	if (isDirectory.value) {
		isTargz.value = false;
		return;
	}
	metaLoading.value = true;
	metaError.value = '';
	innerMeta.value = null;
	try {
		const [metaRes, apiMetaRes] = await Promise.all([
			fetch(`/d/${props.bucketName}/${props.filePath}?meta`),
			fetch('/api/meta'),
		]);
		if (!metaRes.ok) { metaError.value = `取得失敗: ${metaRes.status}`; return; }
		const data = await metaRes.json() as { isTargz?: boolean; isTar?: boolean; isPublic?: boolean; size?: number };
		isTargz.value = data.isTargz ?? false;
		isTar.value = data.isTar ?? false;
		fileSize.value = data.size ?? null;
		fileIsPublic.value = data.isPublic ?? true;

		if (apiMetaRes.ok) {
			const apiMeta = await apiMetaRes.json() as { turnstileEnabled?: boolean; turnstileSiteKey?: string };
			turnstileEnabled.value = apiMeta.turnstileEnabled ?? false;
			turnstileSiteKey.value = apiMeta.turnstileSiteKey ?? '';
		}

		if (!fileIsPublic.value) {
			if (authStore.user) {
				await issueAutoToken();
			} else {
				// キャッシュ済みパスフレーズトークンを復元
				const cached = loadCachedToken();
				if (cached) {
					autoToken.value = cached.token;
					passphraseTokenExpiresAt.value = cached.expiresAt;
					scheduleTokenExpiry(cached.expiresAt);
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
		const body: Record<string, string> = {
			bucketName: props.bucketName,
			filePath: props.filePath,
			passphrase: passphraseInput.value,
		};
		if (turnstileEnabled.value && turnstileToken.value) {
			body.turnstileToken = turnstileToken.value;
		}
		const res = await fetch('/api/file-tokens/create-by-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const result = await res.json() as { token?: string; expiresAt?: number | null; error?: string };
		if (!res.ok) {
			passphraseError.value = result.error ?? `エラー: ${res.status}`;
			return;
		}
		autoToken.value = result.token ?? null;
		passphraseTokenExpiresAt.value = result.expiresAt ?? null;
		saveCachedToken(result.token ?? '', result.expiresAt ?? null);
		scheduleTokenExpiry(result.expiresAt ?? null);
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
	return `autoToken:${props.bucketName}/${props.filePath}`;
}

function clearExpiryTimer(): void {
	if (tokenExpiryTimer !== null) {
		clearTimeout(tokenExpiryTimer);
		tokenExpiryTimer = null;
	}
}

function expireToken(): void {
	autoToken.value = null;
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

function loadCachedToken(): { token: string; expiresAt: number | null } | null {
	try {
		const raw = sessionStorage.getItem(autoTokenCacheKey());
		if (!raw) return null;
		const cached = JSON.parse(raw) as { token: string; expiresAt: number | null };
		// 60秒バッファを持たせて期限チェック
		if (cached.expiresAt !== null && cached.expiresAt < Date.now() + 60_000) return null;
		return cached;
	} catch { return null; }
}

function saveCachedToken(token: string, expiresAt: number | null): void {
	try {
		sessionStorage.setItem(autoTokenCacheKey(), JSON.stringify({ token, expiresAt }));
	} catch { /* quota exceeded etc. */ }
}

async function issueAutoToken(): Promise<void> {
	const cached = loadCachedToken();
	if (cached) {
		autoToken.value = cached.token;
		return;
	}
	autoToken.value = null;
	try {
		const result = await apiPost('/api/file-tokens/create', { bucketName: props.bucketName, filePath: props.filePath, expiresIn: 3600 });
		if (result.ok) {
			autoToken.value = result.data.token;
			saveCachedToken(result.data.token, result.data.expiresAt);
		}
	} catch { /* silent */ }
}

onMounted(fetchMeta);
watch(() => [props.bucketName, props.filePath], () => {
	activeTab.value = 'info';
	autoToken.value = null;
	passphraseTokenExpiresAt.value = null;
	clearExpiryTimer();
	fetchMeta();
});
onUnmounted(clearExpiryTimer);
watch(() => entryPath.value, () => {
	innerMeta.value = null;
	if (isEntryFile.value) fetchInnerMeta();
});
</script>

<template>
  <div>
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <nav class="breadcrumbs" style="margin-bottom:0">
        <template v-for="(seg, i) in breadcrumbs" :key="i">
          <span v-if="i > 0" class="breadcrumbs-sep">/</span>
          <NirA v-if="seg.link" :to="seg.link">{{ seg.name }}</NirA>
          <span v-else class="breadcrumbs-current">{{ seg.name }}</span>
        </template>
      </nav>
      <span
        v-if="!isDirectory && !metaLoading && !metaError"
        :class="fileIsPublic ? 'badge badge-success' : 'badge badge-muted'"
      >
        {{ fileIsPublic ? '公開' : '非公開' }}
      </span>
      <span
        v-if="!isDirectory && !metaLoading && !metaError && (isEntryFile ? innerMeta?.size != null : fileSize != null)"
        :class="'badge badge-muted'"
      >
        {{ formatSize((isEntryFile ? innerMeta?.size : fileSize) ?? 0) }}
      </span>
      <span v-if="passphraseTokenExpiresAt" class="badge badge-info" :title="`${passphraseTokenExpiryStr} まで有効`">
        パスフレーズ認証済み（{{ passphraseTokenExpiryStr }} まで）
      </span>
    </div>

    <div v-if="metaLoading" class="page-loading">
      <span class="spinner"></span>読み込み中...
    </div>
    <div v-else-if="metaError" class="alert alert-error">{{ metaError }}</div>
    <template v-else>
      <!-- アーカイブ内ファイルビュー (ログイン有無問わず) -->
      <template v-if="(isTargz || isTar) && isEntryFile">
        <div class="file-actions">
          <a :href="innerDownloadUrl" download class="btn btn-primary">ダウンロード</a>
          <a v-if="isInnerText" :href="innerDownloadUrl" target="_blank" class="btn btn-secondary">ブラウザで開く</a>
        </div>
        <div v-if="isInnerImage" style="margin-top:16px">
          <img :src="innerDownloadUrl" :alt="entryPath ?? ''" class="file-preview-image">
        </div>
      </template>

      <!-- ファイル・ログイン済み: タブ付きパネル -->
      <template v-else-if="!isDirectory && authStore.user">
        <div class="tab-bar mb-3">
          <button :class="['tab-btn', activeTab === 'info' ? 'tab-btn-active' : '']" @click="activeTab = 'info'">詳細</button>
          <button :class="['tab-btn', activeTab === 'tokens' ? 'tab-btn-active' : '']" @click="activeTab = 'tokens'">アクセストークン</button>
        </div>

        <!-- 詳細タブ: ファイル表示 -->
        <template v-if="activeTab === 'info'">
          <BrowseDirectory v-if="isTargz || isTar" :bucketName="bucketName" :filePath="filePath" :isTargz="isTargz" :isTar="isTar" :entryPath="entryPath ?? ''" :token="autoToken ?? undefined" />
          <BrowseFile v-else :bucketName="bucketName" :filePath="filePath" :token="autoToken ?? undefined" />
        </template>

        <!-- アクセストークンタブ: 公開設定 + トークン管理 -->
        <BrowseFileTokens
          v-else-if="activeTab === 'tokens'"
          :bucketName="bucketName"
          :filePath="filePath"
          :fileIsPublic="fileIsPublic"
          @update:fileIsPublic="fileIsPublic = $event"
        />
      </template>

      <!-- 非ログイン + 非公開 + トークンなし: パスフレーズフォーム -->
      <template v-else-if="needsPassphrase">
        <div class="card">
          <p style="margin-bottom:16px; color:var(--color-text-muted)">このファイルはプライベートです。パスフレーズを入力するとアクセスできます。</p>
          <Form @submit="submitPassphrase" style="display:flex; flex-direction:column; gap:14px; max-width:400px">
            <div class="flex gap-2">
              <div>
              <label class="form-label">パスフレーズ</label>
                <Input.Root v-model="passphraseInput" type="password" required validate-on="submit">
                  <Input.Control placeholder="パスフレーズ" class="form-input" autocomplete="current-password" />
                  <Input.Error v-slot="{ errors }">
                    <span v-for="e in errors" :key="e" class="form-error">{{ e }}</span>
                  </Input.Error>
                </Input.Root>
              </div>
              <Button.Root
                type="submit"
                class="btn btn-primary"
                style="justify-content:center; align-self:flex-end"
                :disabled="passphraseLoading || (turnstileEnabled && !turnstileToken)"
              >
                <Button.Loading v-if="passphraseLoading">認証中...</Button.Loading>
                <Button.Content>アクセス</Button.Content>
              </Button.Root>
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
        <BrowseDirectory v-if="isDirectory || isTargz || isTar" :bucketName="bucketName" :filePath="filePath" :isTargz="isTargz" :isTar="isTar" :entryPath="entryPath ?? ''" :token="autoToken ?? undefined" />
        <BrowseFile v-else-if="!isDirectory" :bucketName="bucketName" :filePath="filePath" :token="autoToken ?? undefined" />
      </template>
    </template>
  </div>
</template>
