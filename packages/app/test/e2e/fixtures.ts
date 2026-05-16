import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD } from './global-setup';

interface TestUser {
	username: string;
	password: string;
	userId: string;
	token: string;
	isAdmin: boolean;
}

interface E2EFixtures {
	adminUser: TestUser;
	loggedInPage: Page;
}

export const test = base.extend<E2EFixtures>({
	adminUser: async ({ request }, use) => {
		const signinRes = await request.post('/api/signin', {
			data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
		});
		if (!signinRes.ok()) {
			throw new Error(`adminUser fixture: signin failed (${signinRes.status()}) — run \`pnpm test:e2e:fresh\` to reset the DB`);
		}
		const { token } = await signinRes.json() as { token: string };

		const meRes = await request.get('/api/account/me', {
			headers: { Authorization: `Bearer ${token}` },
		});
		const user = await meRes.json() as { id: string; username: string; isAdmin: boolean };

		await use({
			username: E2E_ADMIN_USERNAME,
			password: E2E_ADMIN_PASSWORD,
			userId: user.id,
			token,
			isAdmin: user.isAdmin,
		});
	},

	loggedInPage: async ({ page, adminUser }, use) => {
		await page.goto('/');
		await page.evaluate((token) => {
			localStorage.setItem('cfw_fileup_token', token);
		}, adminUser.token);
		await page.reload();
		// Wait for the app to finish auth initialization
		await page.waitForFunction(() => {
			return !document.querySelector('.page-loading');
		}, { timeout: 10_000 });
		await use(page);
	},
});

export { expect } from '@playwright/test';
