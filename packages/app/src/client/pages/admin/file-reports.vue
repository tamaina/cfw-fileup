<script setup lang="ts">
import { onMounted, ref } from 'vue';
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

function reportTitle(report: FileReport): string {
	return report.summary || report.detail || report.id;
}

function fileLabel(report: FileReport): string {
	return report.bucketName && report.filePath ? `${report.bucketName}/${report.filePath}` : report.fileId;
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
        <table class="data-table">
          <thead>
            <tr>
              <th>要約</th>
              <th>状態</th>
              <th>理由</th>
              <th>ファイル</th>
              <th>通報者</th>
              <th>作成</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="report in reports" :key="report.id">
              <td>{{ reportTitle(report) }}</td>
              <td>{{ fileReportStatusLabels[report.status] }}</td>
              <td>{{ report.reasonId ? fileReportReasonLabels[report.reasonId] : 'その他' }}</td>
              <td>{{ fileLabel(report) }}</td>
              <td>{{ report.reporterName }}</td>
              <td>{{ formatDate(report.createdAt) }}</td>
              <td class="col-actions">
                <NirA :to="`/admin/file-reports/${report.id}`" class="btn btn-secondary">詳細</NirA>
              </td>
            </tr>
            <tr v-if="reports.length === 0">
              <td colspan="7" class="col-muted">ファイル通報はありません。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style module lang="scss">
.tableCard {
  padding: 0;
  overflow: hidden;
}
</style>
