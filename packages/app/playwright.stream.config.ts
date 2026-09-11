import { defineConfig } from '@playwright/test';

// 保存経路だけを実ブラウザで検証する。DB・認証・Vite HMR は不要。
export default defineConfig({
	testDir: './test/e2e',
	testMatch: 'stream-download-lifetime.spec.ts',
	workers: 1,
	reporter: 'line',
	use: { acceptDownloads: true },
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{
			name: 'firefox',
			use: {
				browserName: 'firefox',
				// 既定の idle 30秒 / extended idle 300秒を短縮し、両方の期限を越える。
				launchOptions: { firefoxUserPrefs: process.env.STREAM_DOWNLOAD_DEFAULT_TIMEOUTS ? {} : {
					'dom.serviceWorkers.idle_timeout': 1_000,
					'dom.serviceWorkers.idle_extended_timeout': 20_000,
				} },
			},
		},
	],
});
