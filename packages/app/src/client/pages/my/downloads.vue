<script setup lang="ts">
import { computed, ref } from 'vue';
import { downloadStatusHistory, getDownloadStatusPercent, type DownloadStatus } from '@/store/download-status';
import { browserDownloadConcurrency, setBrowserDownloadConcurrency } from '@/store/browser-download-settings';

const concurrency = ref<number | string>(browserDownloadConcurrency.value);
const validConcurrency = computed(() => Number.isSafeInteger(Number(concurrency.value)) && Number(concurrency.value) > 0);
function saveConcurrency(): void {
	if (validConcurrency.value) setBrowserDownloadConcurrency(Number(concurrency.value));
}

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

    <form class="card" :class="$style.settings" @submit.prevent="saveConcurrency">
      <label for="download-concurrency">ダウンロードの変換並列数の上限</label>
      <p class="col-muted">復号・解凍の上限です（初期値3）。通信はこのタブ全体で1本に固定し、32MiBずつ取得します。変換数は処理速度に応じて自動調整します。</p>
      <div class="flex gap-2">
        <input id="download-concurrency" v-model="concurrency" type="number" min="1" step="1" :max="Number.MAX_SAFE_INTEGER" class="form-input" :aria-invalid="!validConcurrency" required>
        <button type="submit" class="btn btn-primary" :disabled="!validConcurrency">保存</button>
      </div>
      <p v-if="!validConcurrency" class="text-danger">1以上の整数を入力してください。</p>
    </form>

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
.settings {
  margin-bottom: 16px;

  input { max-width: 160px; }
}

.tableCard {
  padding: 0;
  overflow: hidden;
}
</style>
