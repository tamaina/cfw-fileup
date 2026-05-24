<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import NirA from '@/components/NirA.vue';
import { fileReportReasonLabels, fileReportRelationshipLabels, fileReportStatusIds, fileReportStatusLabels, type FileReportStatusId } from '../../../shared/file-reports';
import { formatBytes } from '@/utils/byte-size';

type FileReport = ApiSuccess<'/api/admin/list-file-reports'>['data'][number];

const reports = ref<FileReport[]>([]);
const selectedReportId = ref<string | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const actionError = ref('');
const statusFilter = ref<FileReportStatusId | ''>('');
const editStatus = ref<FileReportStatusId>('open');
const editAdminNote = ref('');

const selectedReport = computed(() => reports.value.find(report => report.id === selectedReportId.value) ?? reports.value[0] ?? null);

onMounted(loadReports);

async function loadReports(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const result = await apiPost('/api/admin/list-file-reports', {
			status: statusFilter.value || null,
		});
		if (!result.ok) throw new Error(result.data.message || 'ファイル通報一覧の取得に失敗しました');
		reports.value = result.data;
		if (!selectedReport.value && reports.value[0]) {
			selectReport(reports.value[0]);
		} else if (selectedReport.value) {
			selectReport(selectedReport.value);
		}
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		loading.value = false;
	}
}

function selectReport(report: FileReport): void {
	selectedReportId.value = report.id;
	editStatus.value = report.status;
	editAdminNote.value = report.adminNote;
	actionError.value = '';
}

async function saveReport(): Promise<void> {
	if (!selectedReport.value) return;
	saving.value = true;
	actionError.value = '';
	try {
		const result = await apiPost('/api/admin/update-file-report', {
			reportId: selectedReport.value.id,
			status: editStatus.value,
			adminNote: editAdminNote.value,
		});
		if (!result.ok) throw new Error(result.data.message || '通報対応の保存に失敗しました');
		await loadReports();
	} catch (e) {
		actionError.value = e instanceof Error ? e.message : String(e);
	} finally {
		saving.value = false;
	}
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString();
}

function fileUrl(report: FileReport): string | null {
	if (!report.bucketName || !report.filePath) return null;
	return `/v/${report.bucketName}/${report.filePath}`;
}
</script>

<template>
  <div>
    <NirA to="/admin" class="back-link">← 管理パネルに戻る</NirA>

    <div class="section-header">
      <h2 class="section-title">ファイル通報</h2>
    </div>

    <div v-if="!authStore.user?.isAdmin" class="alert alert-error">
      管理者権限が必要です。
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>
      <div v-if="actionError" class="alert alert-error mb-4">{{ actionError }}</div>

      <div :class="$style.toolbar">
        <select v-model="statusFilter" class="form-input" :class="$style.statusFilter" @change="loadReports">
          <option value="">すべて</option>
          <option v-for="statusId in fileReportStatusIds" :key="statusId" :value="statusId">
            {{ fileReportStatusLabels[statusId] }}
          </option>
        </select>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="loadReports">
          再読み込み
        </button>
      </div>

      <div v-if="loading" class="page-loading">
        <span class="spinner" />読み込み中...
      </div>

      <div v-else :class="$style.layout">
        <div :class="['card', $style.listCard]">
          <button
            v-for="report in reports"
            :key="report.id"
            type="button"
            :class="[$style.reportItem, selectedReport?.id === report.id && $style.reportItemActive]"
            @click="selectReport(report)"
          >
            <span :class="$style.reportItemTitle">{{ report.summary }}</span>
            <span :class="$style.reportItemMeta">
              {{ fileReportStatusLabels[report.status] }} · {{ formatDate(report.createdAt) }}
            </span>
            <span :class="$style.reportItemPath">{{ report.bucketName && report.filePath ? `${report.bucketName}/${report.filePath}` : report.fileId }}</span>
          </button>
          <div v-if="reports.length === 0" :class="$style.empty">ファイル通報はありません。</div>
        </div>

        <div v-if="selectedReport" :class="['card', $style.detailCard]">
          <div :class="$style.detailHeader">
            <div>
              <h3 :class="$style.detailTitle">{{ selectedReport.summary }}</h3>
              <p :class="$style.detailMeta">{{ formatDate(selectedReport.createdAt) }}</p>
            </div>
            <span :class="$style.statusBadge">{{ fileReportStatusLabels[selectedReport.status] }}</span>
          </div>

          <dl :class="$style.detailList">
            <dt>ファイル</dt>
            <dd>
              <NirA v-if="fileUrl(selectedReport)" :to="fileUrl(selectedReport)!">
                {{ selectedReport.bucketName }}/{{ selectedReport.filePath }}
              </NirA>
              <span v-else>{{ selectedReport.fileId }}</span>
            </dd>
            <dt>サイズ / MIME</dt>
            <dd>{{ selectedReport.fileSize === null ? '-' : formatBytes(selectedReport.fileSize) }} / {{ selectedReport.fileMimeType ?? '-' }}</dd>
            <dt>所有者</dt>
            <dd>{{ selectedReport.fileOwnerUsername ?? selectedReport.fileOwnerId ?? '-' }}</dd>
            <dt>通報者</dt>
            <dd>{{ selectedReport.reporterName }} / {{ selectedReport.reporterEmail ?? '-' }}</dd>
            <dt>理由</dt>
            <dd>{{ selectedReport.reasonId ? fileReportReasonLabels[selectedReport.reasonId] : 'その他' }}</dd>
            <dt>関係</dt>
            <dd>{{ selectedReport.relationshipId ? fileReportRelationshipLabels[selectedReport.relationshipId] : '-' }}</dd>
            <dt>連絡先</dt>
            <dd>{{ selectedReport.contact ?? '-' }}</dd>
            <dt>IP / UA</dt>
            <dd>{{ selectedReport.reporterIpAddress ?? '-' }} / {{ selectedReport.reporterUserAgent ?? '-' }}</dd>
            <dt>詳細</dt>
            <dd :class="$style.preWrap">{{ selectedReport.detail }}</dd>
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
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 16px;
}

.statusFilter {
  max-width: 180px;
}

.layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.listCard {
  padding: 0;
  overflow: hidden;
}

.reportItem {
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 12px;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.reportItem:hover,
.reportItemActive {
  background: var(--color-bg);
}

.reportItemTitle {
  font-weight: 600;
}

.reportItemMeta,
.reportItemPath {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.empty {
  padding: 24px;
  color: var(--color-text-muted);
  text-align: center;
}

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

.editForm {
  display: grid;
  gap: 12px;
}

.noteTextarea {
  min-height: 120px;
  resize: vertical;
}

@media (max-width: 860px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .detailList {
    grid-template-columns: 1fr;
  }
}
</style>
