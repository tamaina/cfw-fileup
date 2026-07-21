<script setup lang="ts">
import { ref, computed, defineComponent, h, onMounted, onUnmounted, watch } from 'vue';
import { Button, Dialog, Popover, useTheme } from '@vuetify/v0';
import { CircleFadingArrowUp, Download, Moon, Sun, Upload, User } from '@lucide/vue';
import { mainRouter } from './router';
import { fetchCurrentUser, authStore, clearAuth } from './store/auth';
import { appName, loadAppMeta } from './store/app-meta';
import { navigateFn } from './navigate';
import NirA from './components/NirA.vue';
import { activeUploadJobs, connectUploadWorker, latestUploadJob, uploadWorkerJobs } from './store/upload-worker';
import { downloadStatus, downloadStatusPercent } from './store/download-status';
import { latestMediaConversionErrorJob, mediaConversionJobs } from './store/media-conversion-worker';
import { canSendBrowserUploadNotifications } from './store/browser-upload-settings';
import { formatBytes } from './utils/byte-size';
import type { UploadJobSnapshot } from './workers/upload-worker-types';

type UploadNotificationOptions = NotificationOptions & {
	renotify?: boolean;
};

navigateFn.value = (path) => mainRouter.pushByPath(path);

const theme = useTheme();
const isDark = theme.isDark;

const appNavOpen = ref(false);
const dismissedMediaConversionErrorJobId = ref<string | null>(null);
const mediaConversionErrorDialogJob = computed(() => {
	const job = latestMediaConversionErrorJob.value;
	if (!job || job.id === dismissedMediaConversionErrorJobId.value) return null;
	return job;
});
const mediaConversionErrorDialogOpen = computed(() => mediaConversionErrorDialogJob.value != null);
const hasActiveBackgroundJob = computed(() =>
	activeUploadJobs.value.length > 0
	|| mediaConversionJobs.value.some(job => job.status === 'running')
);
const uploadNotificationStates = new Map<string, {
	status: UploadJobSnapshot['status'];
	lastPercentBucket: number;
	lastNotifiedAt: number;
	finalNotified: boolean;
}>();

function closeAppNav() {
  appNavOpen.value = false;
};

const isReady = ref(false);
const navMediaConversionJob = computed(() => {
	const runningJob = mediaConversionJobs.value.find(job => job.status === 'running');
	if (runningJob) return runningJob;
	const uploadJob = latestUploadJob.value;
	if (!uploadJob) return null;
	return mediaConversionJobs.value.find(job => job.uploadJobId === uploadJob.id && job.status === 'done') ?? null;
});
const navMediaConversionPercent = computed(() => {
	const job = navMediaConversionJob.value;
	if (!job) return 0;
	if (job.status === 'done') return 100;
	if (job.totalFiles <= 0) return 0;
	const currentFileProgress = job.progress ?? 0;
	return Math.min(100, Math.round((job.fileIndex + currentFileProgress) / job.totalFiles * 100));
});
const navUploadPercent = computed(() => {
	const job = latestUploadJob.value;
	if (job?.status === 'done') return 100;
	if (!job || job.totalBytes <= 0) return 0;
	return Math.min(100, Math.round(job.uploadedBytes / job.totalBytes * 100));
});
const navUploadLink = computed(() => {
	const job = latestUploadJob.value;
	if (!job) return '/my/uploadings?tab=browser';
	if (job.status === 'done' && job.completedPath) return `/v/${job.bucketName}/${job.completedPath}`;
	return '/my/uploadings?tab=browser';
});
const navUploadText = computed(() => {
	const job = latestUploadJob.value;
	if (!job) return '';
	if (job.status === 'done') return `完了: ${job.completedPath ?? job.filename}`;
	if (job.status === 'error') return `エラー: ${job.filename || job.prefix || 'アップロード'}`;
	if (job.filename) return job.filename;
	const mediaJob = navMediaConversionJob.value;
	if (mediaJob?.status === 'running') return `メディア変換 ${navMediaConversionPercent.value}%`;
	return 'アップロード準備中';
});
const navDownloadPhaseText = computed(() => {
	const status = downloadStatus.value;
	if (!status) return '';
	if (status.error) return `エラー: ${status.filename}`;
	if (status.progress.phase === 'done') return `完了: ${status.filename}`;
	if (status.progress.networkStalled || status.progress.retrying) {
		const reason = status.progress.networkStalled ? '通信停止を検知' : '通信エラー';
		return `${reason}、Range再試行中 (${status.progress.attempt ?? 1}/${status.progress.maxAttempts ?? 1}): ${status.filename}`;
	}
	const phase = status.progress.phase === 'resolving' ? '対象解決中'
		: status.progress.phase === 'reading' ? '読み込み中'
			: '書き込み中';
	const current = status.progress.currentFile || status.filename;
	const attempt = status.progress.attempt && status.progress.maxAttempts && status.progress.attempt > 1
		? ` (${status.progress.attempt}/${status.progress.maxAttempts})`
		: '';
	return `${phase}${attempt}: ${current}`;
});

(async () => {
	await Promise.all([fetchCurrentUser(), loadAppMeta()]);
	if (authStore.user) connectUploadWorker();
	isReady.value = true;
})();

watch(() => authStore.user, (user) => {
	if (user) connectUploadWorker();
});

watch(uploadWorkerJobs, jobs => {
	if (!canSendBrowserUploadNotifications()) return;
	const liveIds = new Set(jobs.map(job => job.id));
	for (const job of jobs) {
		notifyUploadJobUpdate(job);
	}
	for (const id of uploadNotificationStates.keys()) {
		if (!liveIds.has(id)) uploadNotificationStates.delete(id);
	}
}, { deep: true });

function handleBeforeUnload(event: BeforeUnloadEvent): void {
	if (!hasActiveBackgroundJob.value) return;
	event.preventDefault();
	event.returnValue = '';
}

onMounted(() => {
	window.addEventListener('beforeunload', handleBeforeUnload);
});

onUnmounted(() => {
	window.removeEventListener('beforeunload', handleBeforeUnload);
});

const CurrentPage = computed(() => {
	const resolved = mainRouter.currentRef.value;
	if (!resolved) return null;
	const route = resolved.route;
	if (!('component' in route)) return null;
	const component = route.component;
	const propsMap = resolved.props;
	return defineComponent({
		render() {
			const props: Record<string, unknown> = {};
			propsMap.forEach((v, k) => { props[k] = v; });
			return h(component, props);
		},
	});
});

function logout(): void {
	clearAuth();
	mainRouter.pushByPath('/');
}

function toggleTheme(): void {
	theme.cycle(['light', 'dark']);
}

function closeMediaConversionErrorDialog(): void {
	const job = mediaConversionErrorDialogJob.value;
	if (job) dismissedMediaConversionErrorJobId.value = job.id;
}

function notifyUploadJobUpdate(job: UploadJobSnapshot): void {
	let state = uploadNotificationStates.get(job.id);
	if (!state) {
		state = {
			status: job.status,
			lastPercentBucket: -1,
			lastNotifiedAt: 0,
			finalNotified: false,
		};
		uploadNotificationStates.set(job.id, state);
	}

	if (job.status === 'running') {
		const percent = uploadJobPercent(job);
		const percentBucket = Math.floor(percent / 10);
		const now = Date.now();
		const shouldNotify = state.status !== 'running'
			|| percentBucket > state.lastPercentBucket
			|| now - state.lastNotifiedAt >= 30_000;
		if (shouldNotify) {
			state.lastPercentBucket = percentBucket;
			state.lastNotifiedAt = now;
			void showUploadNotification({
				title: `アップロード中: ${uploadJobLabel(job)}`,
				body: `${percent}%・${formatBytes(job.uploadedBytes)} / ${formatBytes(job.totalBytes)}`,
				tag: uploadNotificationTag(job.id),
				url: '/my/uploadings?tab=browser',
				silent: true,
			});
		}
	} else if (job.status === 'done' && !state.finalNotified) {
		state.finalNotified = true;
		state.lastPercentBucket = 10;
		state.lastNotifiedAt = Date.now();
		void showUploadNotification({
			title: 'アップロード完了',
			body: job.completedPath ? `${job.bucketName}/${job.completedPath}` : uploadJobLabel(job),
			tag: uploadNotificationTag(job.id),
			url: job.completedPath ? `/v/${job.bucketName}/${job.completedPath}` : '/my/uploadings?tab=browser',
		});
	} else if (job.status === 'error' && !state.finalNotified) {
		state.finalNotified = true;
		state.lastNotifiedAt = Date.now();
		void showUploadNotification({
			title: 'アップロード失敗',
			body: job.error ? `${uploadJobLabel(job)}: ${job.error}` : uploadJobLabel(job),
			tag: uploadNotificationTag(job.id),
			url: '/my/uploadings?tab=browser',
		});
	}

	state.status = job.status;
}

function uploadNotificationTag(jobId: string): string {
	return `upload:${jobId}`;
}

function uploadJobPercent(job: UploadJobSnapshot): number {
	if (job.status === 'done') return 100;
	if (job.totalBytes <= 0) return 0;
	return Math.min(100, Math.round(job.uploadedBytes / job.totalBytes * 100));
}

function uploadJobLabel(job: UploadJobSnapshot): string {
	return job.filename || job.completedPath || job.prefix || 'アップロード';
}

async function showUploadNotification(options: {
	title: string;
	body: string;
	tag: string;
	url: string;
	silent?: boolean;
}): Promise<void> {
	try {
		if (!canSendBrowserUploadNotifications()) return;
		const notificationOptions: UploadNotificationOptions = {
			body: options.body,
			badge: '/badge.png',
			icon: '/icon.any-192.png',
			tag: options.tag,
			renotify: true,
			silent: options.silent,
			data: { url: options.url },
		};

		if ('serviceWorker' in navigator) {
			const registration = await navigator.serviceWorker.ready.catch(() => null);
			if (registration) {
				await registration.showNotification(options.title, notificationOptions);
				return;
			}
		}

		const notification = new Notification(options.title, notificationOptions);
		notification.onclick = () => {
			window.focus();
			mainRouter.pushByPath(options.url);
			notification.close();
		};
	} catch (err) {
		console.warn('Failed to show upload notification:', err);
	}
}
</script>

<template>
  <div :class="$style.layout">
    <header :class="$style.nav">
      <div :class="$style.navInner">
        <NirA to="/" :class="$style.navBrand">{{ appName }}</NirA>

        <div :class="$style.navLinks">
          <template v-if="authStore.user">
            <NirA to="/my/buckets" :class="$style.navLink">マイバケット</NirA>
          </template>
          <template v-else>
            <NirA to="/signin" :class="$style.navLink">サインイン</NirA>
            <NirA to="/signup" :class="$style.navLink">サインアップ</NirA>
          </template>
          <NirA to="/tools/media-compress" :class="$style.navLink">画像動画縮小</NirA>
          <NirA to="/about" :class="$style.navLink">About</NirA>
          <template v-if="authStore.user?.isAdmin || authStore.user?.isModerator">
            <NirA to="/admin" :class="$style.navLink">管理</NirA>
          </template>
        </div>

        <div :class="$style.navSpacer" />

        <Button.Root class="btn btn-ghost btn-icon" :aria-label="isDark ? 'ライトモードに切替' : 'ダークモードに切替'" @click="toggleTheme">
          <Button.Content>
            <Sun v-if="isDark" :size="16" :stroke-width="2" />
            <Moon v-else :size="16" :stroke-width="2" />
          </Button.Content>
        </Button.Root>

        <div :class="$style.navUser">
          <template v-if="authStore.user">
            <Popover.Root v-model="appNavOpen">
              <Popover.Activator :class="['btn', 'btn-ghost', $style.navUsername]" aria-haspopup="true" aria-label="ユーザーメニュー">
                <User :size="16" :stroke-width="2" /><span :class="$style.navUsernameText">{{ authStore.user.username }}</span>
              </Popover.Activator>
              <Popover.Content :class="$style.navUserMenu">
                <div :class="$style.navUserMenuInner">
                  <Button.Root :as="NirA" to="/my/uploadings" class="btn btn-ghost w-full" @click="closeAppNav">
                    <Button.Content>アップロード状況</Button.Content>
                  </Button.Root>
                  <Button.Root :as="NirA" to="/my/downloads" class="btn btn-ghost w-full" @click="closeAppNav">
                    <Button.Content>ダウンロード状況</Button.Content>
                  </Button.Root>
                  <Button.Root :as="NirA" to="/my/quota" class="btn btn-ghost w-full" @click="closeAppNav">
                    <Button.Content>クォータ</Button.Content>
                  </Button.Root>
                  <Button.Root :as="NirA" to="/my/payments" class="btn btn-ghost w-full" @click="closeAppNav">
                    <Button.Content>支払い管理</Button.Content>
                  </Button.Root>
                  <Button.Root :as="NirA" to="/my/security" class="btn btn-ghost w-full" @click="closeAppNav">
                    <Button.Content>セキュリティー</Button.Content>
                  </Button.Root>
                  <Button.Root :as="NirA" to="/my/account" class="btn btn-ghost w-full" @click="closeAppNav">
                    <Button.Content>アカウント連携</Button.Content>
                  </Button.Root>
                  <Button.Root class="btn btn-ghost w-full" @click="logout">
                    <Button.Content>ログアウト</Button.Content>
                  </Button.Root>
                </div>
              </Popover.Content>
            </Popover.Root>
          </template>
        </div>
      </div>
      <div :class="$style.statusStrip">
        <div v-if="authStore.user" :class="$style.statusRow">
          <span v-if="latestUploadJob || navMediaConversionJob" :class="$style.uploadProgress" aria-hidden="true">
            <span v-if="navMediaConversionJob" :class="$style.mediaUploadProgressFill" :style="{ width: `${navMediaConversionPercent}%` }" />
            <span :class="$style.uploadProgressFill" :style="{ width: `${navUploadPercent}%` }" />
          </span>
          <NirA to="/uploader" :class="$style.statusAction" aria-label="ファイルアップロード">
            <span :class="$style.statusIcon" aria-hidden="true">
              <Upload :size="16" :stroke-width="2" />
            </span>
            <span v-if="!latestUploadJob">アップロード</span>
          </NirA>
          <NirA v-if="latestUploadJob" :to="navUploadLink" :class="$style.statusTextLink">
            <span :class="$style.statusText">
              {{ navUploadText }}
            </span>
            <span :class="$style.statusPercent">{{ navUploadPercent }}%</span>
          </NirA>
          <NirA to="/my/uploadings?tab=browser" :class="[$style.statusIconButton, !latestUploadJob ? $style.statusRight : null]" aria-label="アップロード履歴">
            <CircleFadingArrowUp :size="16" :stroke-width="2" />
          </NirA>
        </div>
        <div :class="$style.statusRow">
          <span v-if="downloadStatus" :class="$style.downloadProgress" aria-hidden="true">
            <span :class="$style.downloadProgressFill" :style="{ width: `${downloadStatusPercent}%` }" />
          </span>
          <NirA to="/my/downloads" :class="$style.statusAction" aria-label="ダウンロード状況">
            <span :class="$style.statusIcon" aria-hidden="true">
              <Download :size="16" :stroke-width="2" />
            </span>
            <span v-if="navDownloadPhaseText === ''">ダウンロード</span>
          </NirA>
          <div :class="[$style.downloadStatus, !downloadStatus ? $style.statusPlaceholder : null]">
            <span :class="$style.statusText">{{ navDownloadPhaseText }}</span>
            <span v-if="downloadStatus" :class="$style.statusPercent">{{ downloadStatusPercent }}%</span>
          </div>
        </div>
      </div>
    </header>

    <main :class="$style.main">
      <div v-if="!isReady" class="page-loading">
        <span class="spinner" />
        読み込み中...
      </div>
      <component :is="CurrentPage" v-else-if="CurrentPage" />
    </main>

    <Dialog.Root :model-value="mediaConversionErrorDialogOpen" @update:model-value="value => { if (!value) closeMediaConversionErrorDialog(); }">
      <Dialog.Content :class="$style.errorDialog">
        <div :class="$style.errorDialogInner">
          <div :class="$style.errorDialogHeader">
            <Dialog.Title :class="$style.errorDialogTitle">メディア変換に失敗しました</Dialog.Title>
            <button type="button" class="btn btn-ghost btn-sm" @click="closeMediaConversionErrorDialog">閉じる</button>
          </div>
          <p :class="$style.errorDialogDescription">{{ mediaConversionErrorDialogJob?.error }}</p>
          <div :class="$style.errorDialogMeta">
            <span>{{ mediaConversionErrorDialogJob?.filename || mediaConversionErrorDialogJob?.title }}</span>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  </div>
</template>

<style module lang="scss">
.layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.nav {
  position: sticky;
  top: 0;
  z-index: 100;
  min-height: var(--nav-height);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
}

.navInner {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 6px 0;
}

.navBrand {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-primary) !important;
  text-decoration: none !important;
  letter-spacing: -0.3px;
  margin-right: 8px;
  padding-left: 20px;

  &:hover {
    opacity: 0.85;
  }
}

.navLinks {
  display: flex;
  align-items: center;
  gap: 2px;
}

.navLink {
  padding: 6px 10px;
  border-radius: var(--radius);
  color: var(--color-text-muted) !important;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
  text-decoration: none !important;

  &:hover {
    background: var(--color-bg);
    color: var(--color-text) !important;
  }
}

.navSpacer {
  flex: 1;
}

.navUser {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.navUsername {
  font-weight: 500;
  color: var(--color-text);
}

.navUsernameText {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.navUserMenu {
  min-width: 220px;
  max-width: min(280px, calc(100vw - 24px));
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow:
    0 18px 40px rgba(15, 23, 42, 0.18),
    0 4px 12px rgba(15, 23, 42, 0.12);
  padding: 4px;
  text-align: left;
}

.navUserMenuInner {
  display: flex;
  flex-direction: column;

  :global(.btn) {
    justify-content: flex-start;
    min-height: 36px;
    text-align: left;
  }
}

.statusStrip {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0;
  max-width: 1200px;
  margin: 0 auto -1px;
  padding: 2px 20px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted) !important;
  font-size: 0.8125rem;
}

.statusRow {
  position: relative;
  display: flex;
  gap: 8px;
  height: 28px;
  overflow: visible;
  align-items: center;
}

.statusRow > * {
  flex: 0 0 auto;
}

.statusAction {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius);
  color: var(--color-text-muted) !important;
  font-weight: 500;
  line-height: 22px;
  text-decoration: none !important;
  text-wrap: nowrap;

  &:hover {
    background: var(--color-bg);
    color: var(--color-text) !important;
  }
}

.statusTextLink {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--color-text-muted) !important;
  text-decoration: none !important;
  margin-left: auto;

  &:hover {
    color: var(--color-text) !important;
  }
}

.downloadStatus {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  margin-left: auto;
  color: var(--color-text-muted);
  text-align: right;
}

.statusPlaceholder {
  opacity: 0.72;
}

.statusRight {
  margin-left: auto;
}

.statusIconButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius);
  color: var(--color-text-muted) !important;
  text-decoration: none !important;

  &:hover {
    background: var(--color-bg);
    color: var(--color-text) !important;
  }
}

.statusIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}

.statusText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.uploadProgress {
  position: absolute;
  left: -20px;
  right: -20px;
  top: 0;
  height: 2px;
  overflow: hidden;
  background: transparent;
  pointer-events: none;
}

.downloadProgress {
  position: absolute;
  left: -20px;
  right: -20px;
  bottom: 0;
  height: 2px;
  overflow: hidden;
  background: transparent;
  pointer-events: none;
}

.uploadProgressFill {
  position: absolute;
  left: 0;
  top: 0;
  display: block;
  height: 100%;
  background: var(--color-primary);
  transition: width 0.2s ease;
  z-index: 2;
}

.mediaUploadProgressFill {
  position: absolute;
  left: 0;
  top: 0;
  display: block;
  height: 100%;
  background: var(--color-danger);
  transition: width 0.2s ease;
  z-index: 1;
}

.downloadProgressFill {
  display: block;
  height: 100%;
  background: var(--color-success, #16a34a);
  transition: width 0.2s ease;
}

.statusPercent {
  width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.main {
  flex: 1;
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
  padding: 28px 20px 48px;

  :global(.btn) {
    min-height: 36px;
    justify-content: center;
  }

  :global(.action-menu .btn) {
    justify-content: flex-start;
    text-align: left;
  }

  :global(.action-menu .btn > *) {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  :global(.form-input) {
    min-height: 36px;
  }
}

.errorDialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  width: min(440px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.errorDialogInner {
  display: grid;
  gap: 12px;
  padding: 20px;
}

.errorDialogHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.errorDialogTitle {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.errorDialogDescription {
  margin: 0;
  color: var(--color-text);
  line-height: 1.7;
  white-space: pre-wrap;
}

.errorDialogMeta {
  min-width: 0;
  color: var(--color-text-muted);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .nav {
    height: auto;
  }

  .navInner {
    flex-wrap: wrap;
    height: auto;
    padding: 6px 0 0;
    gap: 2px;
  }

  .navBrand {
    flex: 1;
    margin-right: 0;
  }

  .navSpacer {
    display: none;
  }

  .navLinks {
    order: 3;
    width: 100%;
    padding: 0 12px;
    border-top: 1px solid var(--color-border);
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .navLink {
    padding: 4px 8px;
    font-size: 0.8125rem;
    white-space: nowrap;
  }

  .navUsername {
    max-width: min(44vw, 180px);
    padding-inline: 10px;
    justify-content: center;
  }

  .statusStrip {
    padding: 0 12px;
  }

  .uploadProgress {
    left: -12px;
    right: -12px;
  }

  .downloadProgress {
    left: -12px;
    right: -12px;
  }
}
</style>
