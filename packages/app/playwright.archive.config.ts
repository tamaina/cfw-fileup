import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig(base, {
	testMatch: 'archive-decrypt.spec.ts',
	reporter: 'line',
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'firefox', use: { browserName: 'firefox' } },
	],
});
