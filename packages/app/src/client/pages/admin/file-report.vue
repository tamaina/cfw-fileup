<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import NirA from '@/components/NirA.vue';
import { fileReportReasonLabels, fileReportRelationshipLabels, fileReportStatusIds, fileReportStatusLabels, type FileReportStatusId } from '../../../shared/file-reports';
import { formatBytes } from '@/utils/byte-size';

const props = defineProps<{ reportId: string }>();

type FileReport = ApiSuccess<'/api/admin/get-file-report'>['data'];

const report = ref<FileReport | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const actionError = ref('');
const editStatus = ref<FileReportStatusId>('open');
const editAdminNote = ref('');

onMounted(loadReport);

async function loadReport(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/admin/get-file-report', { reportId: props.reportId });
		if (!result.ok) throw new Error(result.data.message || 'ファイル通報の取得に失敗しました');
		report.value = result.data;
		editStatus.value = result.data.status;
		editAdminNote.value = result.data.adminNote;
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		loading.value = false;
	}
}

async function saveReport(): Promise<void> {
	if (!report.value) return;
	saving.value = true;
	actionError.value = '';
	try {
		const result = await apiPost('/api/admin/update-file-report', {
			reportId: report.value.id,
			status: editStatus.value,
			adminNote: editAdminNote.value,
		});
		if (!result.ok) throw new Error(result.data.message || '通報対応の保存に失敗しました');
		await loadReport();
	} catch (e) {
		actionError.value = e instanceof Error ? e.message : String(e);
	} finally {
		saving.value = false;
	}
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString();
}

function fileUrl(fileReport: FileReport): string | null {
	if (!fileReport.bucketName || !fileReport.filePath) return null;
	return `/v/${fileReport.bucketName}/${fileReport.filePath}`;
}
</script>

<template>
  <div>
    <NirA to="/admin/file-reports" class="back-link">← ファイル通報一覧に戻る</NirA>

    <div class="section-header">
      <h2 class="section-title">ファイル通報詳細</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="actionError" class="alert alert-error mb-4">{{ actionError }}</div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>

      <div v-else-if="report" :class="['card', $style.detailCard]">
        <div :class="$style.detailHeader">
          <div>
            <h3 :class="$style.detailTitle">{{ report.summary || report.detail || report.id }}</h3>
            <p :class="$style.detailMeta">{{ formatDate(report.createdAt) }}</p>
          </div>
          <span :class="$style.statusBadge">{{ fileReportStatusLabels[report.status] }}</span>
        </div>

        <dl :class="$style.detailList">
          <dt>ファイル</dt>
          <dd>
            <NirA v-if="fileUrl(report)" :to="fileUrl(report)!">
              {{ report.bucketName }}/{{ report.filePath }}
            </NirA>
            <span v-else>{{ report.fileId }}</span>
          </dd>
          <dt>サイズ / MIME</dt>
          <dd>{{ report.fileSize === null ? '-' : formatBytes(report.fileSize) }} / {{ report.fileMimeType ?? '-' }}</dd>
          <dt>所有者</dt>
          <dd>{{ report.fileOwnerUsername ?? report.fileOwnerId ?? '-' }}</dd>
          <dt>通報者</dt>
          <dd>{{ report.reporterName }} / {{ report.reporterEmail ?? '-' }}</dd>
          <dt>理由</dt>
          <dd>{{ report.reasonId ? fileReportReasonLabels[report.reasonId] : 'その他' }}</dd>
          <dt>関係</dt>
          <dd>{{ report.relationshipId ? fileReportRelationshipLabels[report.relationshipId] : '-' }}</dd>
          <dt>連絡先</dt>
          <dd>{{ report.contact ?? '-' }}</dd>
          <dt>通報時 IP / UA</dt>
          <dd>{{ report.reporterIpAddress ?? '-' }} / {{ report.reporterUserAgent ?? '-' }}</dd>
          <dt>アップロード時 IP / UA</dt>
          <dd>
            {{ report.uploadIpAddress ?? '-' }} / {{ report.uploadUserAgent ?? '-' }}
            <span v-if="report.uploadedAt" :class="$style.inlineMeta">({{ formatDate(report.uploadedAt) }})</span>
          </dd>
          <dt>詳細</dt>
          <dd :class="$style.preWrap">{{ report.detail || '-' }}</dd>
        </dl>

        <form :class="$style.editForm" @submit.prevent="saveReport">
          <div class="form-group">
            <label class="form-label" for="reportStatus">対応状態</label>
            <select id="reportStatus" v-model="editStatus" class="form-input">
              <option v-for="statusId in fileReportStatusIds" :key="statusId" :value="statusId">
                {{ fileReportStatusLabels[statusId] }}
              </option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="adminNote">管理メモ</label>
            <textarea id="adminNote" v-model="editAdminNote" class="form-input" :class="$style.noteTextarea" maxlength="4000" />
          </div>
          <button class="btn btn-primary" type="submit" :disabled="saving">
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </form>
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
.detailCard {
  display: grid;
  gap: 18px;
}

.detailHeader {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.detailTitle {
  margin: 0 0 4px;
  font-size: 1.1rem;
}

.detailMeta {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.statusBadge {
  align-self: start;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 0.8125rem;
  white-space: nowrap;
}

.detailList {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 10px 14px;
  margin: 0;
}

.detailList dt {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.detailList dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.preWrap {
  white-space: pre-wrap;
}

.inlineMeta {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.editForm {
  display: grid;
  gap: 12px;
}

.noteTextarea {
  min-height: 120px;
  resize: vertical;
}

@media (max-width: 640px) {
  .detailHeader {
    display: grid;
  }

  .detailList {
    grid-template-columns: 1fr;
  }
}
</style>
