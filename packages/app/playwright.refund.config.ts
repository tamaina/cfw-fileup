import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './test/e2e', testMatch: 'refunds.spec.ts', workers: 1,
	reporter: [['list']], use: { baseURL: process.env.REFUND_E2E_URL ?? 'http://127.0.0.1:5184', screenshot: 'only-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
