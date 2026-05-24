<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Flag } from '@lucide/vue';
import { authStore } from '@/store/auth';
import { apiPost, type ApiSuccess } from '@/utils/api';
import NirA from '@/components/NirA.vue';
import { fileReportReasonLabels, fileReportStatusIds, fileReportStatusLabels, type FileReportStatusId } from '../../../shared/file-reports';

type FileReport = ApiSuccess<'/api/admin/list-file-reports'>['data'][number];

const reports = ref<FileReport[]>([]);
const loading = ref(true);
const error = ref('');
const statusFilter = ref<FileReportStatusId | ''>('');

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
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		loading.value = false;
	}
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString();
}

function fileLabel(report: FileReport): string {
	if (!report.filePath) return '-';
	return report.filePath.split('/').filter(Boolean).at(-1) ?? report.filePath;
}

function reasonLabel(report: FileReport): string {
	return report.reasonId ? fileReportReasonLabels[report.reasonId] : 'その他';
}

function statusBadgeClass(status: FileReportStatusId): string {
	if (status === 'open') return 'badge badge-warning';
	if (status === 'in_progress') return 'badge badge-info';
	if (status === 'resolved') return 'badge badge-success';
	return 'badge badge-muted';
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

      <div class="flex items-center gap-2 mb-4">
        <select v-model="statusFilter" class="form-input" @change="loadReports">
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

      <div v-else :class="['card', $style.tableCard]">
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>状態</th>
                <th>種類</th>
                <th>ファイル名</th>
                <th>通報者</th>
                <th>作成</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="report in reports" :key="report.id">
                <td :class="$style.labelCell">
                  <span :class="statusBadgeClass(report.status)">{{ fileReportStatusLabels[report.status] }}</span>
                </td>
                <td :class="$style.labelCell">
                  <NirA :to="`/admin/file-reports/${report.id}`" :class="$style.entryLink">
                    <Flag :class="$style.reportIcon" :size="16" :stroke-width="2" aria-hidden="true" />
                    <span class="badge badge-muted">{{ reasonLabel(report) }}</span>
                  </NirA>
                </td>
                <td :class="$style.fileCell">{{ fileLabel(report) }}</td>
                <td>{{ report.reporterName }}</td>
                <td class="col-muted">{{ formatDate(report.createdAt) }}</td>
              </tr>
              <tr v-if="reports.length === 0">
                <td colspan="5">
                  <div class="empty-state">
                    <p>ファイル通報はありません。</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
.tableCard {
  padding: 0;
  overflow: hidden;
}

.fileCell {
  width: 42%;
  min-width: 14em;
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entryLink {
  display: inline-flex;
  align-items: center;
  font-weight: 500;
}

.reportIcon {
  margin-right: 4px;
  color: var(--color-text-muted);
  vertical-align: -3px;
}

.labelCell {
  white-space: nowrap;
}
</style>
