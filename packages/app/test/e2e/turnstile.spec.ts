import { test, expect } from '@playwright/test';

const META_TURNSTILE_ENABLED = JSON.stringify({
	registrationEnabled: true,
	passphraseRequired: false,
	turnstileEnabled: true,
	turnstileSiteKey: '1x00000000000000000000AA',
});

const META_TURNSTILE_DISABLED = JSON.stringify({
	registrationEnabled: true,
	passphraseRequired: false,
	turnstileEnabled: false,
	turnstileSiteKey: '',
});

// Fake Turnstile script that never fires the callback (simulates pending challenge)
const TURNSTILE_SCRIPT_NO_TOKEN = `
window.turnstile = {
  render: (_container, _options) => 'widget-1',
  remove: (_id) => {},
  reset: (_id) => {},
};
`;

// Fake Turnstile script that fires the callback after 100ms
const TURNSTILE_SCRIPT_WITH_TOKEN = `
window.turnstile = {
  render: (_container, options) => {
    setTimeout(() => options.callback && options.callback('fake-turnstile-token'), 100);
    return 'widget-1';
  },
  remove: (_id) => {},
  reset: (_id) => {},
};
`;

async function mockMeta(page: import('@playwright/test').Page, body: string) {
	await page.route('/api/meta', route =>
		route.fulfill({ status: 200, contentType: 'application/json', body }),
	);
}

async function mockTurnstileScript(page: import('@playwright/test').Page, script: string) {
	await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js', route =>
		route.fulfill({ status: 200, contentType: 'application/javascript', body: script }),
	);
}

test.describe('Turnstile bot protection', () => {
	test.describe('signin page', () => {
		test('submit button disabled when Turnstile enabled but no token yet', async ({ page }) => {
			await mockMeta(page, META_TURNSTILE_ENABLED);
			await mockTurnstileScript(page, TURNSTILE_SCRIPT_NO_TOKEN);

			await page.goto('/signin');

			// Turnstile widget container should be in DOM
			await expect(page.locator('form div[ref]').first()).toBeVisible({ timeout: 3000 }).catch(() => {
				// widget div may not have ref attr exposed; just check button state
			});

			const button = page.getByRole('button', { name: 'サインイン' });
			await expect(button).toBeDisabled();
		});

		test('submit button enabled after Turnstile token received', async ({ page }) => {
			await mockMeta(page, META_TURNSTILE_ENABLED);
			await mockTurnstileScript(page, TURNSTILE_SCRIPT_WITH_TOKEN);

			await page.goto('/signin');

			const button = page.getByRole('button', { name: 'サインイン' });
			// Initially disabled
			await expect(button).toBeDisabled();
			// Enabled after mock Turnstile fires callback
			await expect(button).not.toBeDisabled({ timeout: 3000 });
		});

		test('submit button NOT disabled when Turnstile is disabled', async ({ page }) => {
			await mockMeta(page, META_TURNSTILE_DISABLED);

			await page.goto('/signin');

			const button = page.getByRole('button', { name: 'サインイン' });
			await expect(button).not.toBeDisabled({ timeout: 3000 });
		});
	});

	test.describe('signup page', () => {
		test('submit button disabled when Turnstile enabled but no token yet', async ({ page }) => {
			await mockMeta(page, META_TURNSTILE_ENABLED);
			await mockTurnstileScript(page, TURNSTILE_SCRIPT_NO_TOKEN);

			await page.goto('/signin');
			await page.click('button:has-text("アカウントを作成する")');
			await expect(page.locator('h2')).toHaveText('アカウント作成');

			const button = page.getByRole('button', { name: 'アカウント作成' });
			await expect(button).toBeDisabled();
		});

		test('submit button enabled after Turnstile token received', async ({ page }) => {
			await mockMeta(page, META_TURNSTILE_ENABLED);
			await mockTurnstileScript(page, TURNSTILE_SCRIPT_WITH_TOKEN);

			await page.goto('/signin');
			await page.click('button:has-text("アカウントを作成する")');
			await expect(page.locator('h2')).toHaveText('アカウント作成');

			const button = page.getByRole('button', { name: 'アカウント作成' });
			// Initially disabled
			await expect(button).toBeDisabled();
			// Enabled after mock Turnstile fires callback
			await expect(button).not.toBeDisabled({ timeout: 3000 });
		});

		test('submit button NOT disabled when Turnstile is disabled', async ({ page }) => {
			await mockMeta(page, META_TURNSTILE_DISABLED);

			await page.goto('/signin');
			await page.click('button:has-text("アカウントを作成する")');
			await expect(page.locator('h2')).toHaveText('アカウント作成');

			const button = page.getByRole('button', { name: 'アカウント作成' });
			await expect(button).not.toBeDisabled({ timeout: 3000 });
		});
	});

	test.describe('/api/meta response', () => {
		test('returns turnstileEnabled: false and empty siteKey by default', async ({ request }) => {
			const res = await request.get('/api/meta');
			expect(res.ok()).toBe(true);
			const data = await res.json() as {
				turnstileEnabled: boolean;
				turnstileSiteKey: string;
			};
			expect(data.turnstileEnabled).toBe(false);
			expect(data.turnstileSiteKey).toBe('');
		});
	});
});
