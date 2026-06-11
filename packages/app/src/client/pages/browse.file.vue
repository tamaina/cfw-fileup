<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import { AlertDialog, Button, Input } from '@vuetify/v0';
import { Download, Flag, PackageOpen, ShieldCheck, ShieldOff, TextCursorInput, Trash2 } from '@lucide/vue';
import { authHeaders, authStore } from '@/store/auth';
import { apiPost } from '@/utils/api';
import { mainRouter } from '@/router';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import MoveEntryDialog from '@/components/MoveEntryDialog.vue';
import TurnstileWidget from '@/components/TurnstileWidget.vue';
import { fileReportReasonIds, fileReportReasonLabels, fileReportRelationshipIds, fileReportRelationshipLabels, type FileReportReasonId, type FileReportRelationshipId } from '../../shared/file-reports';
import type { DownloadTransformWorkerMessage, DownloadTransformWorkerRequestInput, DownloadTransformProgress } from '@/workers/download-transform.worker';
import { getOpfsTempFile, removeOpfsTempFile } from '@/workers/opfs-temp';
import { completeDownloadStatus, failDownloadStatus, startDownloadStatus, updateDownloadStatus } from '@/store/download-status';
import { registerDownloadedOpfsFile } from '@/store/download-cleanup';
import MarkdownPreview from '@/components/MarkdownPreview.vue';
import RawTextPreview from '@/components/RawTextPreview.vue';
import JsonPreview from '@/components/JsonPreview.vue';
import HlsVideoPreview from '@/components/HlsVideoPreview.vue';
import PreviewInterstitialAd from '@/components/PreviewInterstitialAd.vue';
import { parseExifDisplayItems, type ExifDisplayItem } from '@/utils/exif';

const props = withDefaults(defineProps<{
	bucketName: string;
	filePath: string;
	fileId: string;
	bucketId: string | null;
	isOwner?: boolean;
	isModerationForcedPrivate?: boolean;
	ownerCanDisableFileAds?: boolean;
	token?: string;
	downloadUrlOverride?: string;
	previewUrl?: string;
	downloadFilename?: string;
	downloadErrorOverride?: string;
	mimeType?: string | null;
	extensionMimeType?: string | null;
	hasMimeTypeMismatch?: boolean;
	hasExecutableContent?: boolean;
	reportPath?: string;
	hideManagement?: boolean;
	showAds?: boolean;
	/** HLS プレイリスト再生用URL（スラッシュ温存）。アーカイブ内 m3u8 エントリーで指定される */
	hlsUrl?: string;
}>(), {
	showAds: true,
});

const emit = defineEmits<{
	(e: 'update:isModerationForcedPrivate', value: boolean): void;
	(e: 'download', event: MouseEvent): void;
}>();

const downloadUrl = computed(() => {
	if (props.downloadUrlOverride) return props.downloadUrlOverride;
	if (!props.fileId) return '';
	const base = `/d/${props.fileId}`;
	return props.token ? `${base}?token=${props.token}` : base;
});
const previewUrl = computed(() => props.previewUrl || downloadUrl.value);
const downloadFilename = computed(() => props.downloadFilename || props.filePath.split('/').filter(Boolean).at(-1) || 'download');
const displayFilename = computed(() => props.filePath.split('/').filter(Boolean).at(-1) || props.filePath || 'download');
const visibleMimeType = computed(() => props.mimeType ?? null);
const visibleExtensionMimeType = computed(() => props.extensionMimeType ?? null);
const canReport = computed(() => !props.isOwner && (!props.hideManagement || props.reportPath != null));
const reportPathContext = computed(() => props.reportPath ? `対象パス: ${props.reportPath}` : '');
const isGz = computed(() => {
	const lower = props.filePath.toLowerCase();
	return lower.endsWith('.gz') && !lower.endsWith('.tar.gz');
});
const isImage = computed(() => {
	const ext = props.filePath.split('.').pop()?.toLowerCase() ?? '';
	return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext);
});
const isHlsPlaylist = computed(() => {
	if (props.filePath.toLowerCase().endsWith('.m3u8')) return true;
	const mime = (props.mimeType ?? '').toLowerCase();
	return mime === 'application/vnd.apple.mpegurl' || mime === 'audio/mpegurl' || mime === 'application/x-mpegurl';
});
const isMarkdown = computed(() => {
	const lower = props.filePath.toLowerCase();
	return lower.endsWith('.md') || lower.endsWith('.markdown');
});
const isJson = computed(() => {
	const lower = props.filePath.toLowerCase();
	return lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.geojson');
});
const isTextLike = computed(() => {
	const lower = props.filePath.toLowerCase();
	const ext = lower.split('.').pop() ?? '';
	return ['txt', 'json', 'csv', 'ts', 'js', 'mjs', 'jsx', 'tsx', 'vue', 'css', 'scss', 'html', 'xml', 'yml', 'yaml', 'md', 'markdown', 'c', 'cc', 'cpp', 'cs', 'go', 'h', 'hpp', 'java', 'kt', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'svelte', 'swift'].includes(ext);
});

const deleteError = ref('');
const deleteDialog = ref(false);
const moveDialog = ref(false);
const reportDialog = ref(false);
const moderationError = ref('');
const moderationSaving = ref(false);
const moderationDialog = ref(false);
const moderationValue = ref(false);
const reportLoading = ref(false);
const reportError = ref('');
const reportSuccess = ref('');
const reporterName = ref('');
const reporterEmail = ref('');
const reportReasonId = ref<FileReportReasonId | ''>('');
const reportRelationshipId = ref<FileReportRelationshipId | ''>('');
const reportContact = ref('');
const reportSummary = ref('');
const reportDetail = ref('');
const turnstileEnabled = ref(false);
const turnstileSiteKey = ref('');
const reportTurnstileToken = ref<string | null>(null);
const downloadError = ref('');
const visibleDownloadError = computed(() => props.downloadErrorOverride || downloadError.value);
const downloadProgress = ref<DownloadTransformProgress | null>(null);
const exifItems = ref<ExifDisplayItem[]>([]);
const previewAdCompleted = ref(false);
let downloadTransformWorker: Worker | null = null;
let downloadTransformRequestId = 0;
const downloadTransformRequests = new Map<string, {
	resolve: (value: { opfsName: string; filename: string; mimeType: string }) => void;
	reject: (error: Error & { opfsName?: string }) => void;
}>();

const parentPath = computed(() => {
	const parts = props.filePath.split('/');
	parts.pop();
	return parts.length === 0
		? `/v/${props.bucketName}/`
		: `/v/${props.bucketName}/${parts.join('/')}/`;
});
const canShowPreview = computed(() => props.showAds === false || previewAdCompleted.value);

const canSubmitReport = computed(() =>
	!reportLoading.value &&
	reporterName.value.trim() !== '' &&
	reporterEmail.value.trim() !== '' &&
	(!turnstileEnabled.value || reportTurnstileToken.value !== null),
);
const reporterNameMissing = computed(() => reporterName.value.trim() === '');
const reporterEmailMissing = computed(() => reporterEmail.value.trim() === '');
const requiredReportFieldRule = (value: unknown): true | string => typeof value === 'string' && value.trim() !== '' || '入力してください。';

function reportDetailWithContext(): string {
	if (!props.reportPath) return reportDetail.value;
	const detail = reportDetail.value.trim();
	return detail ? `${reportPathContext.value}\n\n${detail}`.slice(0, 4000) : reportPathContext.value;
}

async function openReportDialog(): Promise<void> {
	reportDialog.value = true;
	reportError.value = '';
	reportSuccess.value = '';
	reportTurnstileToken.value = null;
	if (authStore.user && reporterName.value.trim() === '') {
		reporterName.value = authStore.user.username;
	}
	if (turnstileSiteKey.value !== '' || turnstileEnabled.value) return;
	try {
		const res = await fetch('/api/meta');
		const data = await res.json() as { turnstileEnabled?: boolean; turnstileSiteKey?: string };
		turnstileEnabled.value = data.turnstileEnabled ?? false;
		turnstileSiteKey.value = data.turnstileSiteKey ?? '';
	} catch {
		turnstileEnabled.value = false;
		turnstileSiteKey.value = '';
	}
}

async function submitReport(): Promise<void> {
	reportLoading.value = true;
	reportError.value = '';
	reportSuccess.value = '';
	try {
		const result = await apiPost('/api/file-reports/create', {
			fileId: props.fileId,
			reporterName: reporterName.value,
			reporterEmail: reporterEmail.value,
			reasonId: reportReasonId.value || null,
			relationshipId: reportRelationshipId.value || null,
			contact: reportContact.value.trim() || null,
			summary: reportSummary.value,
			detail: reportDetailWithContext(),
			turnstileToken: turnstileEnabled.value && reportTurnstileToken.value ? reportTurnstileToken.value : undefined,
		});
		if (!result.ok) throw new Error(result.data.message || '通報を送信できませんでした');
		reportSuccess.value = '通報を送信しました。';
		reporterName.value = authStore.user?.username ?? '';
		reporterEmail.value = '';
		reportReasonId.value = '';
		reportRelationshipId.value = '';
		reportContact.value = '';
		reportSummary.value = '';
		reportDetail.value = '';
		reportTurnstileToken.value = null;
	} catch (e) {
		reportError.value = e instanceof Error ? e.message : String(e);
	} finally {
		reportLoading.value = false;
	}
}

async function executeDelete(): Promise<void> {
	deleteDialog.value = false;
	deleteError.value = '';
	if (!props.bucketId) {
		deleteError.value = '削除できません（バケットIDが不明）';
		return;
	}
	const result = await apiPost('/api/files/delete', { bucketId: props.bucketId, path: props.filePath });
	if (!result.ok) {
		deleteError.value = result.data.message ?? '削除失敗';
		return;
	}
	mainRouter.pushByPath(parentPath.value);
}

function requestModerationForcedPrivate(value: boolean): void {
	moderationValue.value = value;
	moderationDialog.value = true;
}

async function updateModerationForcedPrivate(): Promise<void> {
	moderationSaving.value = true;
	moderationDialog.value = false;
	moderationError.value = '';
	try {
		const result = await apiPost('/api/admin/update-file-moderation', {
			fileId: props.fileId,
			isModerationForcedPrivate: moderationValue.value,
		});
		if (!result.ok) throw new Error(result.data.message || 'モデレーション状態を更新できませんでした');
		emit('update:isModerationForcedPrivate', moderationValue.value);
	} catch (e) {
		moderationError.value = e instanceof Error ? e.message : String(e);
	} finally {
		moderationSaving.value = false;
	}
}

function handleMoved(target: { bucketName: string; path: string }): void {
	mainRouter.pushByPath(`/v/${target.bucketName}/${target.path}`);
}

function getDownloadTransformWorker(): Worker {
	if (downloadTransformWorker) return downloadTransformWorker;
	downloadTransformWorker = new Worker(new URL('../workers/download-transform.worker.ts', import.meta.url), { type: 'module' });
	downloadTransformWorker.onmessage = (event: MessageEvent<DownloadTransformWorkerMessage>) => {
		const message = event.data;
		if (message.type === 'progress') {
			downloadProgress.value = message.progress;
			updateDownloadStatus(message.id, message.progress);
			return;
		}
		const pending = downloadTransformRequests.get(message.id);
		if (!pending) return;
		downloadTransformRequests.delete(message.id);
		if (message.type === 'done') {
			pending.resolve({ opfsName: message.opfsName, filename: message.filename, mimeType: message.mimeType });
		} else if (message.type === 'error') {
			const error = new Error(message.error) as Error & { opfsName?: string };
			error.opfsName = message.opfsName;
			pending.reject(error);
		}
	};
	return downloadTransformWorker;
}

function runDownloadTransformWorker(request: DownloadTransformWorkerRequestInput): Promise<{ opfsName: string; filename: string; mimeType: string }> {
	const id = String(++downloadTransformRequestId);
	return new Promise((resolve, reject) => {
		downloadTransformRequests.set(id, { resolve, reject });
		getDownloadTransformWorker().postMessage({ ...request, id });
	});
}

async function cleanupTempFile(opfsName: string | undefined): Promise<void> {
	if (!opfsName) return;
	await removeOpfsTempFile(opfsName);
}

async function downloadOpfsFile(result: { opfsName: string; filename: string; mimeType: string }): Promise<void> {
	const sourceFile = await getOpfsTempFile(result.opfsName);
	const file = new File([sourceFile], result.filename, { type: result.mimeType, lastModified: sourceFile.lastModified });
	const url = URL.createObjectURL(file);
	registerDownloadedOpfsFile(url, result.opfsName);
	const a = document.createElement('a');
	a.href = url;
	a.download = result.filename;
	document.body.append(a);
	a.click();
	a.remove();
}

function decompressedFilename(path: string): string {
	return path.toLowerCase().endsWith('.gz') ? path.slice(0, -3) : path;
}

async function loadExif(): Promise<void> {
	exifItems.value = [];
	if (!canShowPreview.value || !isImage.value || !previewUrl.value) return;
	const requestUrl = previewUrl.value;
	try {
		const res = await fetch(requestUrl, {
			headers: {
				...authHeaders(),
				Range: 'bytes=0-262143',
			},
		});
		if (requestUrl !== previewUrl.value) return;
		if (!res.ok) return;
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (requestUrl !== previewUrl.value) return;
		exifItems.value = parseExifDisplayItems(bytes);
	} catch { /* no EXIF preview */ }
}

function completePreviewAd(): void {
	previewAdCompleted.value = true;
}

async function startDecompressedDownload(): Promise<void> {
	downloadError.value = '';
	downloadProgress.value = null;
	if (!navigator.storage?.getDirectory) {
		downloadError.value = 'このブラウザは OPFS に対応していないため、展開してダウンロードできません。';
		return;
	}
	const statusId = String(downloadTransformRequestId + 1);
	const filename = decompressedFilename(props.filePath);
	startDownloadStatus(statusId, filename);
	try {
		const result = await runDownloadTransformWorker({
			mode: 'download',
			url: downloadUrl.value,
			filename,
			mimeType: 'application/octet-stream',
			transform: 'decompress-gzip',
			authHeaders: authHeaders(),
		});
		await downloadOpfsFile(result);
		completeDownloadStatus(statusId);
		downloadProgress.value = null;
	} catch (err) {
		await cleanupTempFile((err as Error & { opfsName?: string }).opfsName);
		downloadTransformWorker?.terminate();
		downloadTransformWorker = null;
		const message = err instanceof Error ? err.message : String(err);
		failDownloadStatus(statusId, message);
		downloadError.value = message;
	}
}

onBeforeUnmount(() => {
	downloadTransformWorker?.terminate();
	downloadTransformWorker = null;
});
watch([isImage, previewUrl], () => {
	void loadExif();
}, { immediate: true });
watch(() => `${props.fileId}:${props.filePath}:${previewUrl.value}`, () => {
	previewAdCompleted.value = false;
	exifItems.value = [];
});
watch(canShowPreview, () => {
	void loadExif();
});
</script>

<template>
  <div>
    <div v-if="hasMimeTypeMismatch" :class="['alert', 'alert-warning', 'mb-3', $style.fileTypeWarning]">
      <p :class="$style.fileTypeWarningLine">ファイル名の拡張子と内容が一致していない可能性があります。</p>
      <p v-if="hasExecutableContent" :class="$style.fileTypeWarningLine">実行可能ファイルとして検出されています。</p>
      <p v-if="visibleMimeType || visibleExtensionMimeType" :class="$style.fileTypeWarningLine">内容: {{ visibleMimeType ?? '不明' }} / 拡張子: {{ visibleExtensionMimeType ?? '不明' }}</p>
    </div>

    <div class="card file-actions">
      <a :href="downloadUrl" :download="downloadFilename" class="btn btn-primary" @click="emit('download', $event)">
        <Download :size="16" :stroke-width="2" aria-hidden="true" />
        ダウンロード
      </a>
      <button v-if="!hideManagement && isGz" type="button" class="btn btn-secondary" :disabled="downloadProgress != null" @click="startDecompressedDownload">
        <PackageOpen :size="16" :stroke-width="2" aria-hidden="true" />
        展開してダウンロード
      </button>
      <Button.Root v-if="!hideManagement && authStore.user && bucketId" class="btn btn-ghost" @click="moveDialog = true">
        <Button.Content>
          <TextCursorInput :size="16" :stroke-width="2" aria-hidden="true" />
          移動/名前変更
        </Button.Content>
      </Button.Root>
      <Button.Root v-if="!hideManagement && authStore.user" class="btn btn-ghost-danger" @click="deleteDialog = true">
        <Button.Content>
          <Trash2 :size="16" :stroke-width="2" aria-hidden="true" />
          削除
        </Button.Content>
      </Button.Root>
      <Button.Root
        v-if="!hideManagement && (authStore.user?.isAdmin || authStore.user?.isModerator)"
        :class="['btn', isModerationForcedPrivate ? 'btn-ghost' : 'btn-ghost-danger']"
        :disabled="moderationSaving"
        @click="requestModerationForcedPrivate(!isModerationForcedPrivate)"
      >
        <Button.Content>
          <ShieldCheck v-if="isModerationForcedPrivate" :size="16" :stroke-width="2" aria-hidden="true" />
          <ShieldOff v-else :size="16" :stroke-width="2" aria-hidden="true" />
          {{ isModerationForcedPrivate ? '強制非公開を解除' : '強制非公開' }}
        </Button.Content>
      </Button.Root>
      <Button.Root v-if="canReport" class="btn btn-ghost" @click="openReportDialog">
        <Button.Content>
          <Flag :size="16" :stroke-width="2" aria-hidden="true" />
          通報
        </Button.Content>
      </Button.Root>
    </div>

    <PreviewInterstitialAd
      v-if="fileId && showAds !== false && !previewAdCompleted"
      :owner-can-disable-file-ads="ownerCanDisableFileAds"
      @complete="completePreviewAd"
    />

    <div v-if="canShowPreview && isImage" :class="[$style.imagePreview, exifItems.length > 0 ? $style.imagePreviewWithExif : null]">
      <img :src="previewUrl" :alt="filePath" class="file-preview-image">
      <aside v-if="exifItems.length > 0" :class="$style.exifPanel" aria-label="EXIF情報">
        <h3 :class="$style.exifTitle" :title="displayFilename">{{ displayFilename }}</h3>
        <dl :class="$style.exifList">
          <template v-for="item in exifItems" :key="item.label">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </template>
        </dl>
      </aside>
    </div>
    <HlsVideoPreview v-else-if="canShowPreview && isHlsPlaylist && hlsUrl" :src="hlsUrl" :token="token" :class="$style.hlsPreview" />
    <MarkdownPreview v-else-if="canShowPreview && isMarkdown" :url="previewUrl" :filename="filePath" :class="$style.markdownPreview" />
    <JsonPreview v-else-if="canShowPreview && isJson" :url="previewUrl" :filename="filePath" :class="$style.jsonPreview" />
    <RawTextPreview v-else-if="canShowPreview && (isTextLike || isHlsPlaylist)" :url="previewUrl" :filename="filePath" :class="$style.rawPreview" />

    <div v-if="visibleDownloadError" class="alert alert-error mt-3">{{ visibleDownloadError }}</div>
    <div v-if="deleteError" class="alert alert-error mt-3">{{ deleteError }}</div>
    <div v-if="moderationError" class="alert alert-error mt-3">{{ moderationError }}</div>

    <ConfirmDialog
      v-model:open="moderationDialog"
      :title="moderationValue ? 'ファイルを強制非公開' : '強制非公開を解除'"
      :message="moderationValue ? `ファイル「${filePath}」を強制非公開にしますか？` : `ファイル「${filePath}」の強制非公開を解除しますか？`"
      :confirm-label="moderationValue ? '強制非公開にする' : '解除する'"
      :danger="moderationValue"
      @confirm="updateModerationForcedPrivate"
      @cancel="moderationDialog = false"
    />

    <ConfirmDialog
      v-model:open="deleteDialog"
      title="ファイルを削除"
      :message="`「${filePath}」を削除しますか？`"
      confirm-label="削除する"
      :danger="true"
      @confirm="executeDelete"
      @cancel="deleteDialog = false"
    />

    <MoveEntryDialog
      v-if="authStore.user && bucketId"
      v-model:open="moveDialog"
      type="file"
      :source-bucket-id="bucketId"
      :source-bucket-name="bucketName"
      :source-path="filePath"
      @moved="handleMoved"
    />

    <AlertDialog.Root v-model="reportDialog">
      <AlertDialog.Content :class="$style.reportDialog">
        <div v-if="reportSuccess" :class="$style.reportInner">
          <AlertDialog.Title :class="$style.reportTitle">ファイルを通報</AlertDialog.Title>
          <div class="alert alert-success">{{ reportSuccess }}</div>
          <div :class="$style.reportActions">
            <AlertDialog.Cancel class="btn btn-primary" type="button">閉じる</AlertDialog.Cancel>
          </div>
        </div>
        <form v-else :class="$style.reportInner" @submit.prevent="submitReport">
          <AlertDialog.Title :class="$style.reportTitle">ファイルを通報</AlertDialog.Title>
          <div v-if="reportError" class="alert alert-error">{{ reportError }}</div>
          <Input.Root
            v-model="reporterName"
            class="form-group"
            required
            validate-on="input"
            :rules="[requiredReportFieldRule]"
          >
            <label class="form-label" for="reporterName">
              あなたのお名前
              <span :class="$style.requiredBadge">必須</span>
            </label>
            <Input.Control
              id="reporterName"
              class="form-input"
              :class="reporterNameMissing && $style.missingInput"
              maxlength="100"
            />
            <Input.Description class="form-hint">管理者から確認のため連絡する場合があります。</Input.Description>
            <Input.Error v-slot="{ errors }">
              <div v-for="error in errors" :key="error" class="form-hint form-hint--error">{{ error }}</div>
            </Input.Error>
          </Input.Root>
          <Input.Root
            v-model="reporterEmail"
            class="form-group"
            type="email"
            required
            validate-on="input"
            :rules="[requiredReportFieldRule]"
          >
            <label class="form-label" for="reporterEmail">
              メールアドレス
              <span :class="$style.requiredBadge">必須</span>
            </label>
            <Input.Control
              id="reporterEmail"
              class="form-input"
              :class="reporterEmailMissing && $style.missingInput"
              maxlength="320"
            />
            <Input.Description class="form-hint">管理者から確認のため連絡する場合があります。メールアドレスの検証ができない場合は受け付けられません。</Input.Description>
            <Input.Error v-slot="{ errors }">
              <div v-for="error in errors" :key="error" class="form-hint form-hint--error">{{ error }}</div>
            </Input.Error>
          </Input.Root>
          <div :class="$style.reportGrid">
            <div class="form-group">
              <label class="form-label" for="reportReason">通報理由</label>
              <select id="reportReason" v-model="reportReasonId" class="form-input">
                <option value="">その他</option>
                <option v-for="reasonId in fileReportReasonIds" :key="reasonId" :value="reasonId">
                  {{ fileReportReasonLabels[reasonId] }}
                </option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="reportRelationship">通報者の関係</label>
              <select id="reportRelationship" v-model="reportRelationshipId" class="form-input">
                <option value="">未選択</option>
                <option v-for="relationshipId in fileReportRelationshipIds" :key="relationshipId" :value="relationshipId">
                  {{ fileReportRelationshipLabels[relationshipId] }}
                </option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="reportContact">あなたのご連絡先</label>
            <input id="reportContact" v-model="reportContact" class="form-input" maxlength="500">
          </div>
          <div class="form-group">
            <label class="form-label" for="reportSummary">通報の要約</label>
            <input id="reportSummary" v-model="reportSummary" class="form-input" maxlength="200">
          </div>
          <div class="form-group">
            <label class="form-label" for="reportDetail">通報の詳細</label>
            <div v-if="reportPathContext" :class="$style.reportPathContext">{{ reportPathContext }}</div>
            <textarea id="reportDetail" v-model="reportDetail" class="form-input" :class="$style.reportTextarea" maxlength="4000" />
          </div>
          <TurnstileWidget
            v-if="turnstileEnabled && turnstileSiteKey"
            :site-key="turnstileSiteKey"
            @update:token="reportTurnstileToken = $event"
          />
          <div v-if="turnstileEnabled && !reportTurnstileToken" :class="[$style.fieldHint, $style.fieldHintError]">
            確認を完了してください。
          </div>
          <div :class="$style.reportActions">
            <AlertDialog.Cancel class="btn btn-secondary" type="button">閉じる</AlertDialog.Cancel>
            <button class="btn btn-primary" type="submit" :disabled="!canSubmitReport">
              {{ reportLoading ? '送信中...' : turnstileEnabled && !reportTurnstileToken ? '確認中...' : '送信' }}
            </button>
          </div>
        </form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  </div>
</template>

<style module lang="scss">
.imagePreview {
  margin-top: 16px;
}

.imagePreviewWithExif {
  display: grid;
  grid-template-columns: minmax(0, max-content) minmax(220px, 320px);
  align-items: start;
  gap: 16px;
}

.exifPanel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  padding: 16px 16px 8px;
}

.exifTitle {
  margin: 0 0 12px;
  font-size: 1rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.exifList {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0 14px;
  margin: 0;
  font-size: 0.85rem;

  dt {
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    padding: 8px 0;
  }

  dd {
    border-top: 1px solid var(--color-border);
    margin: 0;
    padding: 8px 0;
    overflow-wrap: anywhere;
  }
}

.hlsPreview {
  margin-top: 16px;
}

.markdownPreview {
  margin-top: 16px;
}

.jsonPreview {
  margin-top: 16px;
}

.rawPreview {
  margin-top: 16px;
}

.fileTypeWarning {
  display: grid;
  gap: 4px;
}

.fileTypeWarningLine {
  margin: 0;
}

.reportDialog {
  color: var(--color-text);
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  padding: 0;
  width: min(640px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;

  &::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
}

.reportInner {
  display: grid;
  gap: 14px;
  padding: 24px;
}

.reportTitle {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
}

.requiredBadge {
  display: inline-flex;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--radius);
  background: rgba(220, 38, 38, 0.12);
  color: var(--color-danger);
  font-size: 0.72rem;
  font-weight: 600;
  vertical-align: middle;
}

.missingInput {
  border-color: var(--color-danger);
  box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.12);
}

.fieldHint {
  min-height: 1.2em;
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: 0.8rem;
}

.fieldHintError {
  color: var(--color-danger);
}

.reportGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.reportTextarea {
  min-height: 140px;
  resize: vertical;
}

.reportPathContext {
  margin-bottom: 6px;
  color: var(--color-text-muted);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}

.reportActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 640px) {
  .imagePreviewWithExif {
    grid-template-columns: 1fr;
  }

  .exifPanel {
    width: 100%;
  }

  .reportGrid {
    grid-template-columns: 1fr;
  }
}
</style>
