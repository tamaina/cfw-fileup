import type { FullConfig } from '@playwright/test';

export const E2E_ADMIN_USERNAME = 'e2e_admin';
export const E2E_ADMIN_PASSWORD = 'e2e_password_123';

export default async function globalSetup(config: FullConfig): Promise<void> {
	const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5173';

	// Attempt to create the e2e admin user.
	// On a fresh DB the first signup automatically becomes admin.
	// On an existing DB this returns 409 (user exists) which is fine.
	const res = await fetch(`${baseURL}/api/signup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			username: E2E_ADMIN_USERNAME,
			password: E2E_ADMIN_PASSWORD,
		}),
	});

	if (!res.ok && res.status !== 409) {
		const text = await res.text();
		console.warn(`[globalSetup] signup failed (${res.status}): ${text}`);
		console.warn('[globalSetup] Admin-only tests may fail. Run `pnpm test:e2e:fresh` for a clean state.');
	}
}
