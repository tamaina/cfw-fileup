import { test, expect } from './fixtures';

test.describe('Bucket management', () => {
	test('authenticated user sees my-buckets page', async ({ loggedInPage }) => {
		await loggedInPage.goto('/my/buckets');
		await expect(loggedInPage.locator('h2:has-text("マイバケット")')).toBeVisible();
		await expect(loggedInPage.locator('input[placeholder="バケット名"]')).toBeVisible();
	});

	test('can create a bucket', async ({ loggedInPage }) => {
		const bucketName = `e2e-bucket-${Date.now().toString(36)}`;

		await loggedInPage.goto('/my/buckets');

		await loggedInPage.fill('input[placeholder="バケット名"]', bucketName);
		// Press Enter to submit (Button.Root renders type="button", not type="submit")
		await loggedInPage.press('input[placeholder="バケット名"]', 'Enter');

		// The bucket should appear in the list after creation
		await expect(loggedInPage.locator(`text=${bucketName}`)).toBeVisible({ timeout: 10_000 });
	});

	test('shows login prompt for unauthenticated user on /my/buckets', async ({ page }) => {
		await page.goto('/my/buckets');
		await expect(page.locator('text=ログインが必要です')).toBeVisible();
	});
});
