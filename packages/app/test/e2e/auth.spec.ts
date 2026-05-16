import { test, expect, type Page } from '@playwright/test';

// Button.Root from @vuetify/v0 always renders type="button", ignoring type="submit".
// Forms with multiple text inputs require requestSubmit() to trigger submission.
async function submitForm(page: Page): Promise<void> {
	await page.evaluate(() => {
		(document.querySelector('form') as HTMLFormElement | null)?.requestSubmit();
	});
}

test.describe('Authentication', () => {
	test('signin page renders form elements', async ({ page }) => {
		await page.goto('/signin');
		await expect(page.locator('#username')).toBeVisible();
		await expect(page.locator('#password')).toBeVisible();
		await expect(page.getByRole('button', { name: 'サインイン' })).toBeVisible();
	});

	test('shows error on wrong credentials', async ({ page }) => {
		await page.goto('/signin');
		await page.fill('#username', 'nonexistent_user_xyz');
		await page.fill('#password', 'wrongpassword');
		await submitForm(page);
		await expect(page.locator('.alert-error')).toBeVisible();
	});

	test('can sign in as e2e_admin via UI', async ({ page }) => {
		await page.goto('/signin');
		await page.fill('#username', 'e2e_admin');
		await page.fill('#password', 'e2e_password_123');
		await submitForm(page);
		await expect(page).toHaveURL('/my/buckets');
		await expect(page.locator('.app-nav-username')).toHaveText('e2e_admin');
	});

	test('can sign up a new account via UI and then sign in', async ({ page }) => {
		const suffix = Date.now().toString(36);
		const username = `ui_user_${suffix}`;

		await page.goto('/signin');

		// Switch to signup mode
		await page.click('button:has-text("アカウントを作成する")');
		await expect(page.locator('h2')).toHaveText('アカウント作成');

		await page.fill('#username', username);
		await page.fill('#password', 'testpassword123');
		await submitForm(page);

		// After signup, redirect to /my/buckets
		await expect(page).toHaveURL('/my/buckets');
		await expect(page.locator('.app-nav-username')).toHaveText(username);

		// Sign out
		await page.click('button:has-text("ログアウト")');
		await expect(page).toHaveURL('/signin');

		// Sign in with the newly created credentials
		await page.fill('#username', username);
		await page.fill('#password', 'testpassword123');
		await submitForm(page);
		await expect(page).toHaveURL('/my/buckets');
		await expect(page.locator('.app-nav-username')).toHaveText(username);
	});
});
