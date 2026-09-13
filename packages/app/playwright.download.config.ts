import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
	...base,
	testMatch: ['**/download-parallel.spec.ts', '**/stream-download.spec.ts', '**/stream-download-lifetime.spec.ts', '**/download-benchmark.spec.ts'],
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
	],
});
