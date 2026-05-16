import { defineConfig, devices } from '@playwright/test';

// Use pre-installed browsers in this environment
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= '/opt/pw-browsers';

export default defineConfig({
	testDir: './test/e2e',
	fullyParallel: false,
	forbidOnly: !!process.env['CI'],
	retries: process.env['CI'] ? 2 : 0,
	workers: 1,
	reporter: process.env['CI'] ? 'dot' : [['html', { open: 'never' }]],
	use: {
		baseURL: 'http://localhost:5173',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	webServer: {
		command: 'pnpm dev',
		url: 'http://localhost:5173',
		reuseExistingServer: !process.env['CI'],
		timeout: 120_000,
	},
	globalSetup: './test/e2e/global-setup.ts',
});
