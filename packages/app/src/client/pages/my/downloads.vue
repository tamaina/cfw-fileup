<script setup lang="ts">
import { downloadStatusHistory, getDownloadStatusPercent, type DownloadStatus } from '@/store/download-status';

function phaseLabel(status: DownloadStatus): string {
	if (status.error) return 'エラー';
	if (status.progress.phase === 'done') return '完了';
	if (status.progress.phase === 'resolving') return '対象解決中';
	if (status.progress.networkStalled || status.progress.retrying) return '再試行中';
	if (status.progress.phase === 'reading') return '読み込み中';
	return '書き込み中';
}

function progressLabel(status: DownloadStatus): string {
	const progress = status.progress;
	const attempt = progress.attempt && progress.maxAttempts && progress.attempt > 1
		? `再試行 ${progress.attempt}/${progress.maxAttempts} `
		: '';
	if (progress.totalFiles <= 0) return progress.currentFile || status.filename;
	const current = progress.currentFile ? `: ${progress.currentFile}` : '';
	return `${attempt}${progress.processedFiles}/${progress.totalFiles}${current}`;
}

function formatDate(timestamp: number): string {
	return new Date(timestamp).toLocaleString();
}
</script>

<template>
  <div>
    <div class="section-header">
      <h2 class="section-title">マイダウンロード</h2>
    </div>

    <div v-if="downloadStatusHistory.length === 0" class="empty-state">
      <p>このブラウザから実行したダウンロードはありません。</p>
    </div>
    <div v-else :class="[$style.tableCard, 'card']">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>状態</th>
              <th>対象</th>
              <th class="col-usage">進捗</th>
              <th>詳細</th>
              <th>開始日時</th>
              <th>更新日時</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in downloadStatusHistory" :key="item.id">
              <td>
                <span :class="item.error ? 'badge badge-danger' : item.progress.phase === 'done' ? 'badge badge-success' : 'badge badge-info'">
                  {{ phaseLabel(item) }}
                </span>
              </td>
              <td class="font-mono">{{ item.filename }}</td>
              <td>
                <div class="bucket-usage">
                  <div class="bucket-usage-bar">
                    <div class="bucket-usage-bar-fill" :style="{ width: `${getDownloadStatusPercent(item)}%` }" />
                  </div>
                  <span class="bucket-usage-pct">{{ getDownloadStatusPercent(item) }}%</span>
                </div>
              </td>
              <td>
                <span v-if="item.error" class="text-danger">{{ item.error }}</span>
                <span v-else class="col-muted">{{ progressLabel(item) }}</span>
              </td>
              <td class="col-muted">{{ formatDate(item.startedAt) }}</td>
              <td class="col-muted">{{ formatDate(item.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style module lang="scss">
.tableCard {
  padding: 0;
  overflow: hidden;
}
</style>
