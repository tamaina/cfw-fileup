import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { getWorkerCacheName, workerCacheBaseNames } from '../../src/worker/utils/cache-names';
import { expireDiscountedFuturePlanAssignment } from '../../src/worker/utils/billing';
import { env, app, rawApp, setupDb, clearDb, signup, signin, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupAdminAndUser() {
	const { data: adminData } = await signup('firstuser');
	const { data: userData } = await signup('user1');
	return {
		adminToken: String(adminData.token),
		userToken: String(userData.token),
		userId: String(userData.userId),
	};
}

describe('Admin access control', () => {
	test('non-admin is denied all admin endpoints', async () => {
		await signup('firstuser');
		const { data } = await signup('user1');
		const userToken = String(data.token);

		const endpoints = [
			{ path: '/api/admin/suspend-user', body: { userId: 'x' } },
			{ path: '/api/admin/unsuspend-user', body: { userId: 'x' } },
			{ path: '/api/admin/make-admin', body: { userId: 'x' } },
			{ path: '/api/admin/update-moderator', body: { userId: 'x', isModerator: true } },
			{ path: '/api/admin/list-files', body: {} },
			{ path: '/api/admin/list-moderation-audit-logs', body: {} },
			{ path: '/api/admin/update-file-moderation', body: { fileId: 'x', isModerationForcedPrivate: true } },
			{ path: '/api/admin/delete-file', body: { fileId: 'x' } },
			{ path: '/api/admin/delete-bucket', body: { bucketId: 'x' } },
			{ path: '/api/admin/purge-worker-cache', body: {} },
			{ path: '/api/admin/get-user-effective-quota', body: { userId: 'x' } },
			{ path: '/api/admin/recalculate-user-effective-quota', body: { userId: 'x' } },
			{ path: '/api/admin/update-setting', body: { key: 'registration_mode', value: 'closed' } },
			{ path: '/api/admin/list-plans', body: {} },
			{ path: '/api/admin/create-plan', body: { name: 'Pro' } },
			{ path: '/api/admin/update-plan', body: { planId: 'x', name: 'Pro' } },
			{ path: '/api/admin/assign-user-plan', body: { userId: 'x', planId: 'x', expiresAt: Date.now() + 1_000 } },
			{ path: '/api/admin/get-user-plan', body: { userId: 'x' } },
			{ path: '/api/admin/delete-user-plan', body: { userId: 'x' } },
			{ path: '/api/admin/list-payment-chains', body: {} },
			{ path: '/api/admin/create-payment-chain', body: { chainId: 1, name: 'Ethereum', nativeCurrencyName: 'Ether', nativeCurrencySymbol: 'ETH', nativeCurrencyDecimals: 18 } },
			{ path: '/api/admin/list-payment-assets', body: {} },
			{ path: '/api/admin/create-payment-asset', body: { symbol: 'USDC', name: 'USD Coin' } },
			{ path: '/api/admin/list-payment-asset-deployments', body: {} },
			{ path: '/api/admin/list-payment-asset-plan-prices', body: {} },
			{ path: '/api/admin/list-crypto-payment-orders', body: {} },
			{ path: '/api/admin/check-crypto-payment-order', body: { orderId: 'x' } },
			{ path: '/api/admin/get-billing-sales-summary', body: { from: 0, to: Date.now() + 1_000 } },
		];

		for (const { path, body } of endpoints) {
			const res = await app.request(path, {
				method: 'POST',
				headers: authHeaders(userToken),
				body: JSON.stringify(body),
			}, env);
			expect(res.status).toBe(403);
		}
	});

	test('moderator can use moderation endpoints but not admin-only settings', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const grantRes = await app.request('/api/admin/update-moderator', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, isModerator: true }),
		}, env);
		expect(grantRes.status).toBe(200);

		const allowedRes = await app.request('/api/admin/list-files', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ limit: 10, cursor: null }),
		}, env);
		expect(allowedRes.status).toBe(200);

		const deniedRes = await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ key: 'registration_mode', value: 'closed' }),
		}, env);
		expect(deniedRes.status).toBe(403);
	});
});

describe('POST /api/admin/purge-worker-cache', () => {
	test('admin can rotate Worker cache names', async () => {
		const { adminToken } = await setupAdminAndUser();
		const beforeName = await getWorkerCacheName(env, workerCacheBaseNames.download);

		const res = await app.request('/api/admin/purge-worker-cache', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: boolean; version: string };
		expect(body.ok).toBe(true);
		expect(body.version.length).toBeGreaterThan(0);

		const afterName = await getWorkerCacheName(env, workerCacheBaseNames.download);
		expect(afterName).not.toBe(beforeName);
		expect(afterName).toBe(`${workerCacheBaseNames.download}-v${body.version}`);
	});
});

describe('POST /api/admin/suspend-user', () => {
	test('admin can suspend a user', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		const res = await app.request('/api/admin/suspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(res.status).toBe(200);

		// Suspended user cannot sign in
		const { status } = await signin('user1', 'password123');
		expect(status).toBe(403);
	});

	test('nonexistent user returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/suspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('admin cannot suspend themself', async () => {
		const { data } = await signup('firstuser');
		const adminToken = String(data.token);
		const adminUserId = String(data.userId);

		const res = await app.request('/api/admin/suspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId: adminUserId }),
		}, env);
		expect(res.status).toBe(403);
	});
});

describe('POST /api/admin/unsuspend-user', () => {
	test('admin can unsuspend a user', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		await app.request('/api/admin/suspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);

		const res = await app.request('/api/admin/unsuspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(res.status).toBe(200);

		const listRes = await app.request('/api/admin/list-users', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(listRes.status).toBe(200);
		const users = await listRes.json() as { items: Array<{ id: string; isSuspended: boolean }> };
		expect(users.items.find((user) => user.id === userId)?.isSuspended).toBe(false);
	});

	test('nonexistent user returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/unsuspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/admin/make-admin', () => {
	test('admin cannot create a second admin', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();

		const res = await app.request('/api/admin/make-admin', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(res.status).toBe(403);

		const listRes = await app.request('/api/admin/list-users', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(listRes.status).toBe(200);
		const users = await listRes.json() as { items: Array<{ id: string; isAdmin: boolean }> };
		expect(users.items.find((user) => user.id === userId)?.isAdmin).toBe(false);

		const promotedAdminRes = await app.request('/api/admin/get-global-quota', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(promotedAdminRes.status).toBe(403);
	});

	test('nonexistent user returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/make-admin', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/admin/delete-file', () => {
	test('admin can delete any file', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'test_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketId, path: 'file.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/file.txt`, 'Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		const deleteRes = await app.request('/api/admin/delete-file', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ fileId }),
		}, env);
		expect(deleteRes.status).toBe(200);
	});

	test('nonexistent fileId returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/delete-file', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ fileId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/admin/list-files', () => {
	test('admin can list files regardless of visibility', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'test_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketId, path: 'private.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/private.txt`, 'Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ fileId, visibility: 'private' }),
		}, env);

		const listRes = await app.request('/api/admin/list-files', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(listRes.status).toBe(200);
		const body = await listRes.json() as { items: Array<{ id: string; path: string; visibility: string; isModerationForcedPrivate: boolean }> };
		expect(body.items).toContainEqual(expect.objectContaining({
			id: fileId,
			path: 'private.txt',
			visibility: 'private',
			isModerationForcedPrivate: false,
		}));
	});
});

describe('POST /api/admin/list-moderation-audit-logs', () => {
	test('admin can list audit logs', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		const suspendRes = await app.request('/api/admin/suspend-user', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(suspendRes.status).toBe(200);

		const listRes = await app.request('/api/admin/list-moderation-audit-logs', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(listRes.status).toBe(200);
		const body = await listRes.json() as { items: Array<{ action: string; targetUserId: string | null; createdAt: number }> };
		expect(body.items[0]).toEqual(expect.objectContaining({
			action: 'admin_user_suspended',
			targetUserId: userId,
		}));
		expect(body.items[0].createdAt).toBeGreaterThan(0);
	});
});

describe('POST /api/admin/update-file-moderation', () => {
	test('admin can force a public file private and privileged preview is audited', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'test_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketId, path: 'file.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/file.txt`, 'Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		const updateRes = await app.request('/api/admin/update-file-moderation', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ fileId, isModerationForcedPrivate: true }),
		}, env);
		expect(updateRes.status).toBe(200);

		const publicDownloadRes = await app.request(`/d/${fileId}`, {}, env);
		expect(publicDownloadRes.status).toBe(403);

		const adminDownloadRes = await app.request(`/d/${fileId}`, {
			headers: authHeaders(adminToken),
		}, env);
		expect(adminDownloadRes.status).toBe(200);

		const auditRows = await env.DB.prepare(
			'SELECT action, target_file_id, data FROM moderation_audit_logs WHERE target_file_id = ? ORDER BY id',
		).bind(fileId).all<{ action: string; target_file_id: string; data: string | null }>();

		expect(auditRows.results.map(row => row.action)).toEqual([
			'admin_file_moderation_forced_private_updated',
			'admin_file_previewed',
		]);
		expect(auditRows.results[0].target_file_id).toBe(fileId);
	});

	test('nonexistent fileId returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/update-file-moderation', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ fileId: 'nonexistent', isModerationForcedPrivate: true }),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/admin/delete-bucket', () => {
	test('admin can delete any bucket', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();

		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'test_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };

		const deleteRes = await app.request('/api/admin/delete-bucket', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ bucketId }),
		}, env);
		expect(deleteRes.status).toBe(200);
	});

	test('nonexistent bucketId returns 404', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/delete-bucket', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ bucketId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/admin/update-setting registration_mode', () => {
	test('admin can disable registration', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'registration_mode', value: 'closed' }),
		}, env);
		expect(res.status).toBe(200);

		// New user signup should fail
		const { status } = await signup('user3');
		expect(status).toBe(403);
	});

	test('admin can re-enable registration', async () => {
		const { adminToken } = await setupAdminAndUser();

		// Disable
		await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'registration_mode', value: 'closed' }),
		}, env);

		// Re-enable
		await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'registration_mode', value: 'open' }),
		}, env);

		// New signup should succeed
		const { status } = await signup('user3');
		expect(status).toBe(200);
	});
});

describe('POST /api/admin/update-setting', () => {
	test('admin can update a setting with a matching key-value pair', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'registration_mode', value: 'open' }),
		}, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const settingsRes = await app.request('/api/admin/get-settings', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(settingsRes.status).toBe(200);
		expect(await settingsRes.json()).toContainEqual({ key: 'registration_mode', value: 'open' });
	});

	test('admin can set terms_url and meta exposes it', async () => {
		const { adminToken } = await setupAdminAndUser();
		const termsUrl = 'https://example.com/terms.md';
		const termsUpdatedAt = '2026-05-23';

		const urlRes = await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'terms_url', value: termsUrl }),
		}, env);
		expect(urlRes.status).toBe(200);
		const updatedAtRes = await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'terms_updated_at', value: termsUpdatedAt }),
		}, env);
		expect(updatedAtRes.status).toBe(200);

		const metaRes = await app.request('/api/meta', { method: 'GET' }, env);
		expect(metaRes.status).toBe(200);
		const meta = await metaRes.json() as { termsUrl?: string; termsUpdatedAt?: string };
		expect(meta.termsUrl).toBe(termsUrl);
		expect(meta.termsUpdatedAt).toBe(termsUpdatedAt);
	});

	test('invalid key-value pair returns an error', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'registration_mode', value: 'not-a-mode' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('invalid terms_url returns an error', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'terms_url', value: 'not-a-url' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('invalid terms_updated_at returns an error', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/update-setting', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ key: 'terms_updated_at', value: '2026/05/23' }),
		}, env);
		expect(res.status).toBe(400);
	});
});

describe('Quota management', () => {
	test('admin can set global quota', async () => {
		const { adminToken } = await setupAdminAndUser();

		const res = await app.request('/api/admin/set-global-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ maxBuckets: 5, maxFilesPerBucket: 10 }),
		}, env);
		expect(res.status).toBe(200);

		const quotaRes = await app.request('/api/admin/get-global-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(quotaRes.status).toBe(200);
		const quota = await quotaRes.json() as Record<string, unknown>;
		expect(quota.maxBuckets).toBe(5);
		expect(quota.maxFilesPerBucket).toBe(10);
	});

	test('admin can set per-user quota', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		const res = await app.request('/api/admin/set-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, maxBuckets: 3 }),
		}, env);
		expect(res.status).toBe(200);

		const quotaRes = await app.request('/api/admin/get-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(quotaRes.status).toBe(200);
		const quota = await quotaRes.json() as Record<string, unknown>;
		expect(quota.maxBuckets).toBe(3);
	});

	test('admin can inspect and recalculate effective quota source', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		await app.request('/api/admin/set-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, maxBuckets: 3 }),
		}, env);

		const effectiveRes = await app.request('/api/admin/get-user-effective-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(effectiveRes.status).toBe(200);
		const effective = await effectiveRes.json() as Record<string, unknown>;
		expect(effective.maxBuckets).toBe(3);
		expect(effective.effectiveQuotaSource).toBe('custom');
		expect(typeof effective.effectiveQuotaUpdatedAt).toBe('number');

		const recalcRes = await app.request('/api/admin/recalculate-user-effective-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(recalcRes.status).toBe(200);
		const recalculated = await recalcRes.json() as Record<string, unknown>;
		expect(recalculated.maxBuckets).toBe(3);
		expect(recalculated.effectiveQuotaSource).toBe('custom');
	});

	test('global bucket quota enforced on create', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();

		await app.request('/api/admin/set-global-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ maxBuckets: 1 }),
		}, env);

		await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_1' }),
		}, env);

		const res = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_2' }),
		}, env);
		expect(res.status).toBe(429);
	});

	test('admin can delete user quota', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		await app.request('/api/admin/set-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, maxBuckets: 2 }),
		}, env);

		const res = await app.request('/api/admin/delete-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(res.status).toBe(200);
	});

	test('admin can create, update, list, and disable a plan', async () => {
		const { adminToken, userId } = await setupAdminAndUser();

		const createRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Pro', maxBuckets: 10, maxDailyUploads: 100 }),
		}, env);
		expect(createRes.status).toBe(200);
		const created = await createRes.json() as { id: string; name: string; maxBuckets: number; isEnabled: boolean };
		expect(created.name).toBe('Pro');
		expect(created.maxBuckets).toBe(10);
		expect(created.isEnabled).toBe(true);

		const updateRes = await app.request('/api/admin/update-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: created.id, name: 'Pro Plus', maxBuckets: 12, maxDailyUploads: 120, isEnabled: false }),
		}, env);
		expect(updateRes.status).toBe(200);
		const updated = await updateRes.json() as { isEnabled: boolean };
		expect(updated.isEnabled).toBe(false);

		const listRes = await app.request('/api/admin/list-plans', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(listRes.status).toBe(200);
		const plans = await listRes.json() as Array<{ id: string; name: string; isEnabled: boolean }>;
		expect(plans).toContainEqual(expect.objectContaining({ id: created.id, name: 'Pro Plus', isEnabled: false }));

		const assignRes = await app.request('/api/admin/assign-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, planId: created.id, expiresAt: Date.now() + 86_400_000 }),
		}, env);
		expect(assignRes.status).toBe(400);
		expect(await assignRes.json()).toEqual(expect.objectContaining({ error: 'MANUAL_PLAN_ASSIGNMENT_NOT_SUPPORTED' }));

		const assignmentRes = await app.request('/api/admin/get-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(assignmentRes.status).toBe(200);
		expect(await assignmentRes.json()).toBeNull();

		const unassignRes = await app.request('/api/admin/delete-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(unassignRes.status).toBe(200);

		const deletedAssignmentRes = await app.request('/api/admin/get-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(deletedAssignmentRes.status).toBe(200);
		expect(await deletedAssignmentRes.json()).toBeNull();
	});

	test('plan sortOrder must be unique', async () => {
		const { adminToken } = await setupAdminAndUser();

		const firstRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Basic', sortOrder: 10 }),
		}, env);
		expect(firstRes.status).toBe(200);

		const duplicateCreateRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Basic Copy', sortOrder: 10 }),
		}, env);
		expect(duplicateCreateRes.status).toBe(400);
		expect(await duplicateCreateRes.json()).toEqual(expect.objectContaining({ error: 'PLAN_SORT_ORDER_ALREADY_EXISTS' }));

		const secondRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Pro', sortOrder: 20 }),
		}, env);
		expect(secondRes.status).toBe(200);
		const second = await secondRes.json() as { id: string };

		const duplicateUpdateRes = await app.request('/api/admin/update-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: second.id, name: 'Pro', sortOrder: 10 }),
		}, env);
		expect(duplicateUpdateRes.status).toBe(400);
		expect(await duplicateUpdateRes.json()).toEqual(expect.objectContaining({ error: 'PLAN_SORT_ORDER_ALREADY_EXISTS' }));
	});
});

describe('Crypto payment administration', () => {
	const contractAddress = '0x1111111111111111111111111111111111111111';
	const usdtContractAddress = '0x5555555555555555555555555555555555555555';
	const recipientAddress = '0x2222222222222222222222222222222222222222';

	async function createCryptoOffer(adminToken: string) {
		const planRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Crypto Pro', maxBuckets: 5 }),
		}, env);
		expect(planRes.status).toBe(200);
		const plan = await planRes.json() as { id: string };

		const chainRes = await app.request('/api/admin/create-payment-chain', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				chainId: 8453,
				name: 'Base',
				nativeCurrencyName: 'Ether',
				nativeCurrencySymbol: 'ETH',
				nativeCurrencyDecimals: 18,
				blockExplorerUrl: 'https://basescan.org',
				confirmationsRequired: 1,
			}),
		}, env);
		expect(chainRes.status).toBe(200);

		const assetRes = await app.request('/api/admin/create-payment-asset', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ symbol: 'USD', name: 'US Dollar' }),
		}, env);
		expect(assetRes.status).toBe(200);
		const asset = await assetRes.json() as { id: string };

		const deploymentRes = await app.request('/api/admin/create-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				chainId: 8453,
				tokenSymbol: 'USDC',
				tokenName: 'USD Coin',
				contractAddress,
				decimals: 6,
				recipientAddress,
			}),
		}, env);
		expect(deploymentRes.status).toBe(200);
		const deployment = await deploymentRes.json() as { id: string; tokenSymbol: string; tokenName: string };

		const priceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: plan.id,
				amountBaseUnits: '30000000',
				durationDays: 90,
			}),
		}, env);
		expect(priceRes.status).toBe(200);
		const price = await priceRes.json() as { id: string };
		return { plan, asset, deployment, price };
	}

	async function insertUserPlanAssignmentFixture(input: {
		id?: string;
		userId: string;
		planId: string;
		startsAt?: number;
		expiresAt: number;
		priceAssetId: string;
		priceAmountBaseUnits?: string;
		priceDurationDays?: number;
		priceDurationUnit?: string;
		createdAt?: number;
		updatedAt?: number;
	}) {
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO user_plan_assignments (
				id, user_id, plan_id, starts_at, expires_at,
				price_asset_id, price_amount_base_units, price_duration_days, price_duration_unit,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			input.id ?? `assignment-${now}-${Math.random()}`,
			input.userId,
			input.planId,
			input.startsAt ?? now - 1_000,
			input.expiresAt,
			input.priceAssetId,
			input.priceAmountBaseUnits ?? '30000000',
			input.priceDurationDays ?? 90,
			input.priceDurationUnit ?? 'days',
			input.createdAt ?? now,
			input.updatedAt ?? now,
		).run();
	}

	async function createLinkedWallet(userId: string, chainId = 8453, address = '0x3333333333333333333333333333333333333333') {
		const now = Date.now();
		const id = `wallet-${now}-${Math.random()}`;
		await env.DB.prepare(
			'INSERT INTO user_wallets (id, user_id, chain_id, address, label, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
		).bind(id, userId, chainId, address, now, now).run();
		return { id, chainId, address };
	}

	async function enableCryptoPayments(rpcUrls = '{"8453":"http://127.0.0.1:9/rpc"}') {
		(env as unknown as Record<string, string>).EVM_CHAIN_RPC_URLS = rpcUrls;
		await env.DB.prepare(
			'INSERT INTO app_settings (key, value) VALUES (\'crypto_payments_enabled\', \'true\') ON CONFLICT(key) DO UPDATE SET value = \'true\'',
		).run();
	}

	async function disableCryptoPayments() {
		await env.DB.prepare(
			'INSERT INTO app_settings (key, value) VALUES (\'crypto_payments_enabled\', \'false\') ON CONFLICT(key) DO UPDATE SET value = \'false\'',
		).run();
	}

	async function getOfferQuote(userToken: string, priceId: string, deploymentId: string) {
		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string; deploymentId: string; quote: { discountBaseUnits: string; payableAmountBaseUnits: string; quoteCreatedAt: number; effectiveStartsAt: number; effectiveExpiresAt: number; currentPlan: { id: string } | null } }>;
		const offer = offers.find(item => item.id === priceId && item.deploymentId === deploymentId);
		expect(offer).toBeTruthy();
		if (offer == null) throw new Error('Expected offer to exist');
		return offer.quote;
	}

	async function createOrderBody(userToken: string, priceId: string, deploymentId: string, payerWalletId: string) {
		const quote = await getOfferQuote(userToken, priceId, deploymentId);
		return createOrderBodyWithQuote(priceId, deploymentId, payerWalletId, quote);
	}

	function createOrderBodyWithQuote(priceId: string, deploymentId: string, payerWalletId: string, quote: { payableAmountBaseUnits: string; quoteCreatedAt: number }) {
		return {
			priceId,
			deploymentId,
			payerWalletId,
			quotedAmountBaseUnits: quote.payableAmountBaseUnits,
			quoteCreatedAt: quote.quoteCreatedAt,
		};
	}

	test('admin can create chain, asset, deployment, and plan price', async () => {
		const { adminToken } = await setupAdminAndUser();
		const { price } = await createCryptoOffer(adminToken);

		const period = await env.DB.prepare('SELECT id, amount_base_units, starts_at, expires_at FROM payment_asset_plan_prices WHERE id = ?').bind(price.id).first<{ id: string; amount_base_units: string; starts_at: number; expires_at: number | null }>();
		expect(period).toMatchObject({
			id: price.id,
			amount_base_units: '30000000',
			expires_at: null,
		});
		expect(period?.starts_at).toEqual(expect.any(Number));

		const listRes = await app.request('/api/admin/list-payment-asset-plan-prices', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(listRes.status).toBe(200);
		const prices = await listRes.json() as Array<{ id: string; assetSymbol: string; chainId: number | null; amountBaseUnits: string; priceHistory: unknown[]; dealDisplay: { canShowDeal: boolean; reason: string } }>;
		expect(prices).toContainEqual(expect.objectContaining({
			id: price.id,
			assetSymbol: 'USD',
			chainId: null,
			amountBaseUnits: '30000000',
			dealDisplay: expect.objectContaining({ canShowDeal: false, reason: 'reference_not_higher' }),
		}));
		expect(prices.find(item => item.id === price.id)?.priceHistory).toHaveLength(1);
	});

	test('creating a replacement plan price uses immutable price rows as history', async () => {
		const { adminToken } = await setupAdminAndUser();
		const { plan, asset } = await createCryptoOffer(adminToken);
		const expiresAt = Date.now() + 1_000;

		const expireRes = await app.request('/api/admin/expire-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ priceId: price.id, expiresAt }),
		}, env);
		expect(expireRes.status).toBe(200);
		const replacementRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: plan.id,
				amountBaseUnits: '25000000',
				durationDays: 90,
				durationUnit: 'days',
				startsAt: expiresAt,
			}),
		}, env);
		expect(replacementRes.status).toBe(200);
		const updated = await replacementRes.json() as {
			priceHistory: Array<{ priceId: string; amountBaseUnits: string; startsAt: number; expiresAt: number | null }>;
			dealDisplay: { canShowDeal: boolean; referenceAmountBaseUnits: string | null };
			priceDisplayWindow: { previousPeriod: { amountBaseUnits: string } | null; currentPeriod: { amountBaseUnits: string } | null };
		};
		expect(updated.priceHistory).toHaveLength(2);
		expect(updated.priceHistory.map(period => period.amountBaseUnits)).toEqual(['30000000', '25000000']);
		expect(updated.priceHistory[0]?.expiresAt).toBe(expiresAt);
		expect(updated.priceDisplayWindow.previousPeriod).toEqual(expect.objectContaining({ amountBaseUnits: '30000000' }));
		expect(updated.priceDisplayWindow.currentPeriod).toEqual(expect.objectContaining({ amountBaseUnits: '25000000' }));
	});

	test('indefinite plan prices cannot duplicate the same asset plan and duration', async () => {
		const { adminToken } = await setupAdminAndUser();
		const { plan, asset } = await createCryptoOffer(adminToken);

		const duplicateRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: plan.id,
				amountBaseUnits: '35000000',
				durationDays: 90,
				durationUnit: 'days',
				expiresAt: null,
			}),
		}, env);
		expect(duplicateRes.status).toBe(400);
		const body = await duplicateRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_PRICE_ALREADY_EXISTS');
	});

	test('plan prices cannot be lower for a longer duration on the same asset plan', async () => {
		const { adminToken } = await setupAdminAndUser();
		const { plan, asset } = await createCryptoOffer(adminToken);

		const invertedRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: plan.id,
				amountBaseUnits: '25000000',
				durationDays: 180,
				durationUnit: 'days',
			}),
		}, env);
		expect(invertedRes.status).toBe(400);
		const body = await invertedRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_PRICE_ORDER_INVALID');
	});

	test('overlapping plan prices keep duration price order checks', async () => {
		const { adminToken } = await setupAdminAndUser();
		const { plan, asset } = await createCryptoOffer(adminToken);

		const campaignRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: plan.id,
				amountBaseUnits: '25000000',
				durationDays: 180,
				durationUnit: 'days',
				expiresAt: Date.now() + 86_400_000,
			}),
		}, env);
		expect(campaignRes.status).toBe(400);
		const body = await campaignRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_PRICE_ORDER_INVALID');
	});

	test('same chain and contract address cannot be registered twice', async () => {
		const { adminToken } = await setupAdminAndUser();
		const { asset } = await createCryptoOffer(adminToken);

		const duplicateRes = await app.request('/api/admin/create-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				chainId: 8453,
				tokenSymbol: 'USDC',
				tokenName: 'USD Coin',
				contractAddress,
				decimals: 6,
				recipientAddress,
			}),
		}, env);
		expect(duplicateRes.status).toBe(400);
		const body = await duplicateRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_ASSET_DEPLOYMENT_ALREADY_EXISTS');
	});

	test('invalid checksum payment addresses return a payment validation error', async () => {
		const { adminToken } = await setupAdminAndUser();
		const { asset } = await createCryptoOffer(adminToken);

		const invalidChecksumRes = await app.request('/api/admin/create-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				chainId: 8453,
				tokenSymbol: 'USDC',
				tokenName: 'USD Coin',
				contractAddress: '0xAa00000000000000000000000000000000000000',
				decimals: 6,
				recipientAddress,
			}),
		}, env);
		expect(invalidChecksumRes.status).toBe(400);
		const body = await invalidChecksumRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_TRANSACTION_INVALID');
	});

	test('malformed wallet signatures return wallet signature invalid', async () => {
		const { userToken } = await setupAdminAndUser();
		await enableCryptoPayments();

		const beginRes = await app.request('/api/account/wallets/link/begin', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({
				chainId: 8453,
				address: '0x3333333333333333333333333333333333333333',
				currentPassword: 'password123',
			}),
		}, env);
		expect(beginRes.status).toBe(200);
		const challenge = await beginRes.json() as { nonce: string; message: string };

		const verifyRes = await app.request('/api/account/wallets/link/verify', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({
				nonce: challenge.nonce,
				message: challenge.message,
				signature: '0xabc',
			}),
		}, env);
		expect(verifyRes.status).toBe(400);
		const body = await verifyRes.json() as { error: string };
		expect(body.error).toBe('WALLET_SIGNATURE_INVALID');
	});

	test('expired plan prices are kept for admin history but hidden from user offers', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { plan, asset, deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);
		const expiredAt = Date.now() + 1_000;

		const updateRes = await app.request('/api/admin/expire-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ priceId: price.id, expiresAt: expiredAt }),
		}, env);
		expect(updateRes.status).toBe(200);

		const replacementRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: plan.id,
				amountBaseUnits: '35000000',
				durationDays: 90,
				durationUnit: 'days',
				startsAt: expiredAt,
			}),
		}, env);
		expect(replacementRes.status).toBe(200);
		const replacement = await replacementRes.json() as { id: string };

		const adminListRes = await app.request('/api/admin/list-payment-asset-plan-prices', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(adminListRes.status).toBe(200);
		const adminPrices = await adminListRes.json() as Array<{ id: string; expiresAt: number | null }>;
		expect(adminPrices).toContainEqual(expect.objectContaining({ id: price.id, expiresAt: expiredAt }));
		expect(adminPrices).toContainEqual(expect.objectContaining({ id: replacement.id, expiresAt: null }));

		await new Promise(resolve => setTimeout(resolve, 1_100));

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string; amountBaseUnits: string }>;
		expect(offers).not.toContainEqual(expect.objectContaining({ id: price.id }));
		expect(offers).toContainEqual(expect.objectContaining({ id: replacement.id, amountBaseUnits: '35000000' }));

		const expiredOrderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(expiredOrderRes.status).toBe(404);

		const expireReplacementRes = await app.request('/api/admin/expire-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ priceId: replacement.id, expiresAt: Date.now() + 1_000 }),
		}, env);
		expect(expireReplacementRes.status).toBe(200);

		const restoredPriceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: plan.id,
				amountBaseUnits: '30000000',
				durationDays: 90,
				durationUnit: 'days',
				startsAt: Date.now() + 1_000,
			}),
		}, env);
		expect(restoredPriceRes.status).toBe(200);
		const restoredPrice = await restoredPriceRes.json() as { id: string };
		await new Promise(resolve => setTimeout(resolve, 1_100));

		const restoredOffersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(restoredOffersRes.status).toBe(200);
		const restoredOffers = await restoredOffersRes.json() as Array<{ id: string }>;
		expect(restoredOffers).toContainEqual(expect.objectContaining({ id: restoredPrice.id }));
	});

	test('overlapping plan price periods are rejected', async () => {
		const { adminToken, userToken } = await setupAdminAndUser();
		const { plan, asset, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();

		const limitedRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: plan.id,
				amountBaseUnits: '25000000',
				durationDays: 90,
				durationUnit: 'days',
				expiresAt: Date.now() + 86_400_000,
			}),
		}, env);
		expect(limitedRes.status).toBe(400);

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string; amountBaseUnits: string }>;
		expect(offers).toContainEqual(expect.objectContaining({ id: price.id, amountBaseUnits: '30000000' }));
	});

	test('user can list offers and create an order with a price snapshot', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string; assetSymbol: string; tokenSymbol: string; chainName: string }>;
		expect(offers).toContainEqual(expect.objectContaining({ id: price.id, assetSymbol: 'USD', tokenSymbol: 'USDC', chainName: 'Base' }));

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { id: string; planId: string; amountBaseUnits: string; chainId: number; contractAddress: string; recipientAddress: string; payerAddress: string; status: string; taxName: string; taxRate: string; taxCurrency: string; taxIncludedAmountBaseUnits: string; taxExcludedAmountBaseUnits: string; taxAmountBaseUnits: string; taxStatementId: string | null };
		expect(order).toMatchObject({
			amountBaseUnits: '30000000',
			chainId: 8453,
			contractAddress,
			payerAddress: wallet.address,
			recipientAddress,
			status: 'pending',
			taxName: '消費税',
			taxRate: '0.1',
			taxCurrency: 'USD',
			taxIncludedAmountBaseUnits: '30000000',
			taxExcludedAmountBaseUnits: '27272727',
			taxAmountBaseUnits: '2727273',
		});
		expect(order.taxStatementId).toBeTruthy();
		const stored = await env.DB.prepare('SELECT cf_region_snapshot FROM crypto_payment_orders WHERE id = ?').bind(order.id).first<{ cf_region_snapshot: string }>();
		expect(JSON.parse(stored?.cf_region_snapshot ?? '{}')).toMatchObject({
			country: 'JP',
			continent: 'AS',
			regionCode: '13',
			timezone: 'Asia/Tokyo',
		});
		const paidAt = Date.now();
		await env.DB.prepare('UPDATE crypto_payment_orders SET status = \'paid\', paid_at = ? WHERE id = ?').bind(paidAt, order.id).run();
		const receiptRes = await app.request('/api/billing/get-payment-receipt', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ orderId: order.id }),
		}, env);
		expect(receiptRes.status).toBe(200);
		const receipt = await receiptRes.json() as { order: { id: string; taxAmountBaseUnits: string; taxCurrency: string }; seller: { name: string } };
		expect(receipt.order).toMatchObject({ id: order.id, taxAmountBaseUnits: '2727273', taxCurrency: 'USD' });
		expect(receipt.seller.name).toBeTruthy();
		const summaryRes = await app.request('/api/admin/get-billing-sales-summary', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ from: paidAt - 1_000, to: paidAt + 1_000 }),
		}, env);
		expect(summaryRes.status).toBe(200);
		const summary = await summaryRes.json() as {
			count: number;
			grossAmountBaseUnits: string;
			netAmountBaseUnits: string;
			taxAmountBaseUnits: string;
			byCurrency: Array<{ taxCurrency: string; grossAmountBaseUnits: string; netAmountBaseUnits: string; taxAmountBaseUnits: string }>;
			byRate: Array<{ taxRate: string; taxCurrency: string; taxAmountBaseUnits: string }>;
			byPlan: Array<{ planId: string; planName: string; grossAmountBaseUnits: string }>;
			byAsset: Array<{ assetId: string | null; tokenSymbol: string; grossAmountBaseUnits: string }>;
		};
		expect(summary).toMatchObject({ count: 1, grossAmountBaseUnits: '30000000', netAmountBaseUnits: '27272727', taxAmountBaseUnits: '2727273' });
		expect(summary.byCurrency).toContainEqual(expect.objectContaining({ taxCurrency: 'USD', grossAmountBaseUnits: '30000000', netAmountBaseUnits: '27272727', taxAmountBaseUnits: '2727273' }));
		expect(summary.byRate).toContainEqual(expect.objectContaining({ taxRate: '0.1', taxCurrency: 'USD', taxAmountBaseUnits: '2727273' }));
		expect(summary.byPlan).toContainEqual(expect.objectContaining({ planId: order.planId, planName: 'Crypto Pro', grossAmountBaseUnits: '30000000' }));
		expect(summary.byAsset).toContainEqual(expect.objectContaining({ tokenSymbol: 'USDC', grossAmountBaseUnits: '30000000' }));
	});

	test('crypto order creation rejects regions outside billing rules', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			cf: { country: 'US', continent: 'NA', regionCode: 'CA', isEUCountry: false },
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		} as RequestInit & { cf: Record<string, unknown> }, env);
		expect(orderRes.status).toBe(403);
		const body = await orderRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_REGION_NOT_ALLOWED');
	});

	test('crypto order creation supports regional allow rules', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		await env.DB.prepare(
			'INSERT INTO app_settings (key, value) VALUES (\'billing_region_rules\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		).bind('{"mode":"allow","rules":[{"country":"US","regionCode":"CA"}]}').run();
		const wallet = await createLinkedWallet(userId);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			cf: { country: 'US', continent: 'NA', regionCode: 'CA', region: 'California', isEUCountry: false },
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		} as RequestInit & { cf: Record<string, unknown> }, env);
		expect(orderRes.status).toBe(200);
	});

	test('crypto order creation supports EU deny rules', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		await env.DB.prepare(
			'INSERT INTO app_settings (key, value) VALUES (\'billing_region_rules\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		).bind('{"mode":"deny","rules":[{"isEUCountry":true}]}').run();
		const wallet = await createLinkedWallet(userId);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			cf: { country: 'DE', continent: 'EU', regionCode: 'BE', isEUCountry: '1' },
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		} as RequestInit & { cf: Record<string, unknown> }, env);
		expect(orderRes.status).toBe(403);
		const body = await orderRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_REGION_NOT_ALLOWED');
	});

	test('crypto order creation rejects missing or invalid region rule data', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const missingCfRes = await rawApp.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(missingCfRes.status).toBe(403);

		await env.DB.prepare(
			'INSERT INTO app_settings (key, value) VALUES (\'billing_region_rules\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		).bind('{"mode":"allow","rules":[{}]}').run();
		const invalidRulesRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(invalidRulesRes.status).toBe(403);
		const body = await invalidRulesRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_REGION_NOT_ALLOWED');
	});

	test('one USD price can be paid through multiple token deployments', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { asset, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const usdtDeploymentRes = await app.request('/api/admin/create-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				chainId: 8453,
				tokenSymbol: 'USDT',
				tokenName: 'Tether USD',
				contractAddress: usdtContractAddress,
				decimals: 6,
				recipientAddress,
			}),
		}, env);
		expect(usdtDeploymentRes.status).toBe(200);
		const usdtDeployment = await usdtDeploymentRes.json() as { id: string };

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string; deploymentId: string; assetSymbol: string; tokenSymbol: string; quote: { payableAmountBaseUnits: string; quoteCreatedAt: number } }>;
		expect(offers.filter(offer => offer.id === price.id).map(offer => offer.tokenSymbol).sort()).toEqual(['USDC', 'USDT']);
		const usdtOffer = offers.find(offer => offer.deploymentId === usdtDeployment.id);
		expect(usdtOffer).toEqual(expect.objectContaining({ assetSymbol: 'USD', tokenSymbol: 'USDT' }));
		if (usdtOffer == null) throw new Error('Expected USDT offer to exist');

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify(createOrderBodyWithQuote(price.id, usdtDeployment.id, wallet.id, usdtOffer.quote)),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { tokenSymbol: string; deploymentId: string; contractAddress: string };
		expect(order).toMatchObject({
			tokenSymbol: 'USDT',
			deploymentId: usdtDeployment.id,
			contractAddress: usdtContractAddress,
		});
	});

	test('user can cancel their own pending crypto order before transaction submission', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { id: string; status: string; txHash: string | null };
		expect(order).toMatchObject({ status: 'pending', txHash: null });

		const cancelRes = await app.request('/api/billing/cancel-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ orderId: order.id }),
		}, env);
		expect(cancelRes.status).toBe(200);

		const paymentsRes = await app.request('/api/billing/list-my-payments', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ limit: 20, cursor: null }),
		}, env);
		expect(paymentsRes.status).toBe(200);
		const payments = await paymentsRes.json() as { items: Array<{ id: string }> };
		expect(payments.items).not.toContainEqual(expect.objectContaining({ id: order.id }));

		const secondCancelRes = await app.request('/api/billing/cancel-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ orderId: order.id }),
		}, env);
		expect(secondCancelRes.status).toBe(404);
	});

	test('admin can list crypto payment orders for a specific user', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { data: otherData } = await signup('user2');
		const otherToken = String(otherData.token);
		const otherUserId = String(otherData.userId);
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);
		const otherWallet = await createLinkedWallet(otherUserId, 8453, '0x4444444444444444444444444444444444444444');

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify(await createOrderBody(userToken, price.id, deployment.id, wallet.id)),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { id: string; userId: string };

		const otherOrderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(otherToken),
			body: JSON.stringify(await createOrderBody(otherToken, price.id, deployment.id, otherWallet.id)),
		}, env);
		expect(otherOrderRes.status).toBe(200);
		const otherOrder = await otherOrderRes.json() as { id: string; userId: string };

		const adminListRes = await app.request('/api/admin/list-crypto-payment-orders', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, limit: 20, cursor: null }),
		}, env);
		expect(adminListRes.status).toBe(200);
		const adminList = await adminListRes.json() as { items: Array<{ id: string; userId: string }> };
		expect(adminList.items).toContainEqual(expect.objectContaining({ id: order.id, userId }));
		expect(adminList.items).not.toContainEqual(expect.objectContaining({ id: otherOrder.id, userId: otherUserId }));
	});

	test('admin can recheck another user crypto payment order', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { data: otherData } = await signup('user2');
		const otherToken = String(otherData.token);
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify(await createOrderBody(userToken, price.id, deployment.id, wallet.id)),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { id: string; status: string };
		await env.DB.prepare('UPDATE crypto_payment_orders SET expires_at = ? WHERE id = ?').bind(Date.now() - 1_000, order.id).run();

		const userCheckRes = await app.request('/api/billing/check-crypto-order', {
			method: 'POST',
			headers: authHeaders(otherToken),
			body: JSON.stringify({ orderId: order.id }),
		}, env);
		expect(userCheckRes.status).toBe(404);

		const adminCheckRes = await app.request('/api/admin/check-crypto-payment-order', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ orderId: order.id }),
		}, env);
		expect(adminCheckRes.status).toBe(200);
		const checked = await adminCheckRes.json() as { id: string; userId: string; status: string };
		expect(checked).toMatchObject({ id: order.id, userId, status: 'expired' });
	});

	test('payment offers preview same-plan extension and upgrade discount', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { asset, deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);
		const assignmentExpiresAt = Date.now() + 30 * 86_400_000;

		await insertUserPlanAssignmentFixture({
			userId,
			planId: plan.id,
			expiresAt: assignmentExpiresAt,
			priceAssetId: asset.id,
		});

		const upgradePlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Crypto Max', maxBuckets: 20 }),
		}, env);
		expect(upgradePlanRes.status).toBe(200);
		const upgradePlan = await upgradePlanRes.json() as { id: string };
		const upgradePriceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: upgradePlan.id,
				amountBaseUnits: '90000000',
				durationDays: 90,
				durationUnit: 'days',
			}),
		}, env);
		expect(upgradePriceRes.status).toBe(200);
		const upgradePrice = await upgradePriceRes.json() as { id: string };

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{
			id: string;
			quote: {
				baseAmountBaseUnits: string;
				discountBaseUnits: string;
				payableAmountBaseUnits: string;
				effectiveExpiresAt: number;
				quoteCreatedAt: number;
				currentPlan: { id: string } | null;
			};
		}>;
		const samePlanOffer = offers.find(offer => offer.id === price.id);
		const upgradeOffer = offers.find(offer => offer.id === upgradePrice.id);
		expect(samePlanOffer?.quote.payableAmountBaseUnits).toBe('30000000');
		expect(samePlanOffer?.quote.discountBaseUnits).toBe('0');
		expect(samePlanOffer?.quote.effectiveExpiresAt ?? 0).toBeGreaterThan(assignmentExpiresAt);
		expect(upgradeOffer?.quote.baseAmountBaseUnits).toBe('90000000');
		expect(BigInt(upgradeOffer?.quote.discountBaseUnits ?? '0')).toBeGreaterThan(0n);
		expect(BigInt(upgradeOffer?.quote.payableAmountBaseUnits ?? '90000000')).toBeLessThan(90_000_000n);
		expect(upgradeOffer?.quote.currentPlan).toEqual(expect.objectContaining({ id: plan.id }));
		if (upgradeOffer == null) throw new Error('Expected upgrade offer to exist');

		const invalidQuoteRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({
				priceId: upgradePrice.id,
				deploymentId: deployment.id,
				payerWalletId: wallet.id,
				quotedAmountBaseUnits: '90000000',
				quoteCreatedAt: upgradeOffer.quote.quoteCreatedAt,
			}),
		}, env);
		expect(invalidQuoteRes.status).toBe(400);
		const invalidQuote = await invalidQuoteRes.json() as { error: string };
		expect(invalidQuote.error).toBe('PAYMENT_QUOTE_INVALID');

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify(createOrderBodyWithQuote(upgradePrice.id, deployment.id, wallet.id, upgradeOffer.quote)),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as {
			amountBaseUnits: string;
			planName: string;
			quoteBaseAmountBaseUnits: string;
			quoteDiscountBaseUnits: string;
			quoteEffectiveExpiresAt: number;
			quoteCurrentPlanId: string | null;
		};
		expect(BigInt(order.amountBaseUnits)).toBeLessThan(90_000_000n);
		expect(order.planName).toBe('Crypto Max');
		expect(order.quoteBaseAmountBaseUnits).toBe('90000000');
		expect(BigInt(order.quoteDiscountBaseUnits)).toBeGreaterThan(0n);
		expect(order.quoteEffectiveExpiresAt).toBe(upgradeOffer.quote.effectiveExpiresAt);
		expect(order.quoteCurrentPlanId).toBe(plan.id);
	});

	test('payment offers prorate upgrades from assignment acquisition price', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { plan, asset, deployment } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const assignmentExpiresAt = Date.now() + 30 * 86_400_000;

		await insertUserPlanAssignmentFixture({
			userId,
			planId: plan.id,
			expiresAt: assignmentExpiresAt,
			priceAssetId: asset.id,
			priceAmountBaseUnits: '15000000',
		});

		const upgradePlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Crypto Max', maxBuckets: 20 }),
		}, env);
		expect(upgradePlanRes.status).toBe(200);
		const upgradePlan = await upgradePlanRes.json() as { id: string };
		const upgradePriceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: upgradePlan.id,
				amountBaseUnits: '90000000',
				durationDays: 90,
				durationUnit: 'days',
			}),
		}, env);
		expect(upgradePriceRes.status).toBe(200);
		const upgradePrice = await upgradePriceRes.json() as { id: string };

		const quote = await getOfferQuote(userToken, upgradePrice.id, deployment.id);
		expect(BigInt(quote.discountBaseUnits)).toBeGreaterThanOrEqual(4_999_000n);
		expect(BigInt(quote.discountBaseUnits)).toBeLessThanOrEqual(5_000_000n);
		expect(BigInt(quote.payableAmountBaseUnits)).toBeGreaterThanOrEqual(85_000_000n);
		expect(BigInt(quote.payableAmountBaseUnits)).toBeLessThanOrEqual(85_001_000n);
		expect(quote.currentPlan).toEqual(expect.objectContaining({ id: plan.id }));
	});

	test('payment offers do not prorate upgrades from an acquisition price for another asset', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { plan, asset } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const assignmentExpiresAt = Date.now() + 30 * 86_400_000;

		await insertUserPlanAssignmentFixture({
			userId,
			planId: plan.id,
			expiresAt: assignmentExpiresAt,
			priceAssetId: asset.id,
			priceAmountBaseUnits: '15000000',
		});

		const otherAssetRes = await app.request('/api/admin/create-payment-asset', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ symbol: 'POINT', name: 'Point' }),
		}, env);
		expect(otherAssetRes.status).toBe(200);
		const otherAsset = await otherAssetRes.json() as { id: string };
		const otherDeploymentRes = await app.request('/api/admin/create-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: otherAsset.id,
				chainId: 8453,
				tokenSymbol: 'POINT',
				tokenName: 'Point Token',
				contractAddress: usdtContractAddress,
				decimals: 6,
				recipientAddress,
			}),
		}, env);
		expect(otherDeploymentRes.status).toBe(200);
		const otherDeployment = await otherDeploymentRes.json() as { id: string };
		const otherCurrentPriceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: otherAsset.id,
				planId: plan.id,
				amountBaseUnits: '60000000',
				durationDays: 90,
				durationUnit: 'days',
			}),
		}, env);
		expect(otherCurrentPriceRes.status).toBe(200);
		const upgradePlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Crypto Max', maxBuckets: 20 }),
		}, env);
		expect(upgradePlanRes.status).toBe(200);
		const upgradePlan = await upgradePlanRes.json() as { id: string };
		const otherUpgradePriceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: otherAsset.id,
				planId: upgradePlan.id,
				amountBaseUnits: '90000000',
				durationDays: 90,
				durationUnit: 'days',
			}),
		}, env);
		expect(otherUpgradePriceRes.status).toBe(200);
		const otherUpgradePrice = await otherUpgradePriceRes.json() as { id: string };

		const quote = await getOfferQuote(userToken, otherUpgradePrice.id, otherDeployment.id);
		expect(BigInt(quote.discountBaseUnits)).toBeGreaterThanOrEqual(19_999_000n);
		expect(BigInt(quote.discountBaseUnits)).toBeLessThanOrEqual(20_000_000n);
		expect(quote.currentPlan).toEqual(expect.objectContaining({ id: plan.id }));
	});

	test('payment offers schedule lower sortOrder plan after current higher plan expires', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { plan, asset, deployment } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const updateBasePlanRes = await app.request('/api/admin/update-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: plan.id, name: 'Crypto Basic', maxBuckets: 5, sortOrder: 10 }),
		}, env);
		expect(updateBasePlanRes.status).toBe(200);

		const higherPlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Crypto Max', maxBuckets: 20, sortOrder: 20 }),
		}, env);
		expect(higherPlanRes.status).toBe(200);
		const higherPlan = await higherPlanRes.json() as { id: string };
		const higherPriceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: higherPlan.id,
				amountBaseUnits: '90000000',
				durationDays: 90,
				durationUnit: 'days',
			}),
		}, env);
		expect(higherPriceRes.status).toBe(200);

		const assignmentExpiresAt = Date.now() + 30 * 86_400_000;
		await insertUserPlanAssignmentFixture({
			userId,
			planId: higherPlan.id,
			expiresAt: assignmentExpiresAt,
			priceAssetId: asset.id,
			priceAmountBaseUnits: '90000000',
		});

		const quote = await getOfferQuote(userToken, price.id, deployment.id);
		expect(quote.payableAmountBaseUnits).toBe('30000000');
		expect(quote.effectiveStartsAt).toBe(assignmentExpiresAt);
		expect(quote.effectiveExpiresAt).toBe(assignmentExpiresAt + 90 * 86_400_000);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify(createOrderBodyWithQuote(price.id, deployment.id, wallet.id, quote)),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { amountBaseUnits: string; quoteEffectiveStartsAt: number; quoteEffectiveExpiresAt: number };
		expect(order.amountBaseUnits).toBe('30000000');
		expect(order.quoteEffectiveStartsAt).toBe(assignmentExpiresAt);
		expect(order.quoteEffectiveExpiresAt).toBe(quote.effectiveExpiresAt);
	});

	test('payment offers discount upgrades from a future scheduled downgrade', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { plan, asset, deployment } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();

		const updateBasePlanRes = await app.request('/api/admin/update-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: plan.id, name: 'Crypto Basic', maxBuckets: 5, sortOrder: 10 }),
		}, env);
		expect(updateBasePlanRes.status).toBe(200);

		const higherPlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Crypto Max', maxBuckets: 20, sortOrder: 20 }),
		}, env);
		expect(higherPlanRes.status).toBe(200);
		const higherPlan = await higherPlanRes.json() as { id: string };
		const higherPriceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: higherPlan.id,
				amountBaseUnits: '90000000',
				durationDays: 90,
				durationUnit: 'days',
			}),
		}, env);
		expect(higherPriceRes.status).toBe(200);
		const higherPrice = await higherPriceRes.json() as { id: string };

		const activeExpiresAt = Date.now() + 30 * 86_400_000;
		const futureDowngradeExpiresAt = activeExpiresAt + 90 * 86_400_000;
		await insertUserPlanAssignmentFixture({
			id: 'assignment-active-higher',
			userId,
			planId: higherPlan.id,
			expiresAt: activeExpiresAt,
			priceAssetId: asset.id,
			priceAmountBaseUnits: '90000000',
		});
		await insertUserPlanAssignmentFixture({
			id: 'assignment-future-downgrade',
			userId,
			planId: plan.id,
			startsAt: activeExpiresAt,
			expiresAt: futureDowngradeExpiresAt,
			priceAssetId: asset.id,
		});

		const quote = await getOfferQuote(userToken, higherPrice.id, deployment.id);
		expect(quote.currentPlan).toEqual(expect.objectContaining({ id: plan.id }));
		expect(quote.discountBaseUnits).toBe('30000000');
		expect(quote.payableAmountBaseUnits).toBe('60000000');
		expect(quote.effectiveStartsAt).toBe(activeExpiresAt);
		expect(quote.effectiveExpiresAt).toBe(futureDowngradeExpiresAt);
	});

	test('paid upgrade expires the future downgrade used for discount', async () => {
		const { adminToken, userId } = await setupAdminAndUser();
		const { plan, asset } = await createCryptoOffer(adminToken);
		const higherPlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Crypto Max', maxBuckets: 20, sortOrder: 20 }),
		}, env);
		expect(higherPlanRes.status).toBe(200);
		const higherPlan = await higherPlanRes.json() as { id: string };

		const now = Date.now();
		const activeExpiresAt = now + 30 * 86_400_000;
		const futureDowngradeExpiresAt = activeExpiresAt + 90 * 86_400_000;
		await insertUserPlanAssignmentFixture({
			id: 'assignment-active-higher',
			userId,
			planId: higherPlan.id,
			startsAt: now - 1_000,
			expiresAt: activeExpiresAt,
			priceAssetId: asset.id,
			priceAmountBaseUnits: '90000000',
			createdAt: now,
			updatedAt: now,
		});
		await insertUserPlanAssignmentFixture({
			id: 'assignment-future-downgrade',
			userId,
			planId: plan.id,
			startsAt: activeExpiresAt,
			expiresAt: futureDowngradeExpiresAt,
			priceAssetId: asset.id,
			createdAt: now,
			updatedAt: now,
		});

		await expireDiscountedFuturePlanAssignment(env, {
			userId,
			targetPlanId: higherPlan.id,
			quoteCurrentPlanId: plan.id,
			quoteCurrentPlanExpiresAt: futureDowngradeExpiresAt,
			quoteCreatedAt: now,
			quoteDiscountBaseUnits: '30000000',
			quoteDiscountAssignmentIds: ['assignment-future-downgrade'],
			quoteEffectiveStartsAt: activeExpiresAt,
			quoteEffectiveExpiresAt: futureDowngradeExpiresAt,
			now,
		});

		const assignments = await env.DB.prepare('SELECT id FROM user_plan_assignments ORDER BY id').all<{ id: string }>();
		expect(assignments.results.map(row => row.id)).toEqual(['assignment-active-higher']);
	});

	test('paid upgrade does not expire an active plan used for discount', async () => {
		const { adminToken, userId } = await setupAdminAndUser();
		const { plan, asset } = await createCryptoOffer(adminToken);
		const now = Date.now();
		const activeExpiresAt = now + 90 * 86_400_000;
		await insertUserPlanAssignmentFixture({
			id: 'assignment-active-basic',
			userId,
			planId: plan.id,
			startsAt: now,
			expiresAt: activeExpiresAt,
			priceAssetId: asset.id,
			createdAt: now,
			updatedAt: now,
		});

		await expireDiscountedFuturePlanAssignment(env, {
			userId,
			targetPlanId: plan.id,
			quoteCurrentPlanId: plan.id,
			quoteCurrentPlanExpiresAt: activeExpiresAt,
			quoteCreatedAt: now,
			quoteDiscountBaseUnits: '30000000',
			quoteDiscountAssignmentIds: ['assignment-active-basic'],
			quoteEffectiveStartsAt: now,
			quoteEffectiveExpiresAt: activeExpiresAt,
			now,
		});

		const assignment = await env.DB.prepare('SELECT id FROM user_plan_assignments WHERE id = ?').bind('assignment-active-basic').first<{ id: string }>();
		expect(assignment?.id).toBe('assignment-active-basic');
	});

	test('payment offers do not discount first purchase or expired subscriptions', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { plan, asset, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();

		const firstOffersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(firstOffersRes.status).toBe(200);
		const firstOffers = await firstOffersRes.json() as Array<{
			id: string;
			quote: { discountBaseUnits: string; payableAmountBaseUnits: string; currentPlan: { id: string } | null };
			dealDisplay: { canShowDeal: boolean; reason: string };
		}>;
		expect(firstOffers.find(offer => offer.id === price.id)?.quote).toMatchObject({
			discountBaseUnits: '0',
			payableAmountBaseUnits: '30000000',
			currentPlan: null,
		});
		expect(firstOffers.find(offer => offer.id === price.id)?.dealDisplay).toMatchObject({
			canShowDeal: false,
			reason: 'reference_not_higher',
		});

		await insertUserPlanAssignmentFixture({
			userId,
			planId: plan.id,
			expiresAt: Date.now() - 1_000,
			priceAssetId: asset.id,
		});

		const expiredOffersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(expiredOffersRes.status).toBe(200);
		const expiredOffers = await expiredOffersRes.json() as Array<{
			id: string;
			quote: { discountBaseUnits: string; payableAmountBaseUnits: string; currentPlan: { id: string } | null };
		}>;
		expect(expiredOffers.find(offer => offer.id === price.id)?.quote).toMatchObject({
			discountBaseUnits: '0',
			payableAmountBaseUnits: '30000000',
			currentPlan: null,
		});
	});

	test('disabled plans remain assignable but hidden from user payment offers', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { asset, deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const disablePlanRes = await app.request('/api/admin/update-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: plan.id, name: 'Crypto Pro', maxBuckets: 5, isEnabled: false }),
		}, env);
		expect(disablePlanRes.status).toBe(200);

		await insertUserPlanAssignmentFixture({
			userId,
			planId: plan.id,
			expiresAt: Date.now() + 86_400_000,
			priceAssetId: asset.id,
		});

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string }>;
		expect(offers).not.toContainEqual(expect.objectContaining({ id: price.id }));

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(orderRes.status).toBe(403);
		const orderError = await orderRes.json() as { error: string };
		expect(orderError.error).toBe('FORBIDDEN');
	});

	test('disabled payment assets hide offers and reject order creation', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { asset, deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const disableAssetRes = await app.request('/api/admin/update-payment-asset', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				symbol: 'USD',
				name: 'US Dollar',
				isEnabled: false,
			}),
		}, env);
		expect(disableAssetRes.status).toBe(200);

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string }>;
		expect(offers).not.toContainEqual(expect.objectContaining({ id: price.id }));

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({
				priceId: price.id,
				deploymentId: deployment.id,
				payerWalletId: wallet.id,
				quotedAmountBaseUnits: '30000000',
				quoteCreatedAt: Date.now(),
			}),
		}, env);
		expect(orderRes.status).toBe(403);
		const orderError = await orderRes.json() as { error: string };
		expect(orderError.error).toBe('FORBIDDEN');

		const enableAssetRes = await app.request('/api/admin/update-payment-asset', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				symbol: 'USD',
				name: 'US Dollar',
				isEnabled: true,
			}),
		}, env);
		expect(enableAssetRes.status).toBe(200);

		const restoredOffersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(restoredOffersRes.status).toBe(200);
		const restoredOffers = await restoredOffersRes.json() as Array<{ id: string }>;
		expect(restoredOffers).toContainEqual(expect.objectContaining({ id: price.id }));
	});

	test('admin can update deployment recipient and disable the deployment', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { asset, deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);
		const newRecipientAddress = '0x4444444444444444444444444444444444444444';

		const updateRes = await app.request('/api/admin/update-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				deploymentId: deployment.id,
				assetId: asset.id,
				chainId: 8453,
				tokenSymbol: deployment.tokenSymbol,
				tokenName: deployment.tokenName,
				contractAddress,
				decimals: 6,
				recipientAddress: newRecipientAddress,
				isEnabled: true,
			}),
		}, env);
		expect(updateRes.status).toBe(200);
		const updated = await updateRes.json() as { recipientAddress: string };
		expect(updated.recipientAddress).toBe(newRecipientAddress);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { recipientAddress: string };
		expect(order.recipientAddress).toBe(newRecipientAddress);

		const disableRes = await app.request('/api/admin/update-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				deploymentId: deployment.id,
				assetId: asset.id,
				chainId: 8453,
				tokenSymbol: deployment.tokenSymbol,
				tokenName: deployment.tokenName,
				contractAddress,
				decimals: 6,
				recipientAddress: newRecipientAddress,
				isEnabled: false,
			}),
		}, env);
		expect(disableRes.status).toBe(200);

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string }>;
		expect(offers).toEqual([]);
	});

	test('RPC-disabled crypto payments return empty availability without endpoint errors', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		const wallet = await createLinkedWallet(userId);
		await enableCryptoPayments('');

		const metaRes = await app.request('/api/meta', { method: 'GET' }, env);
		expect(metaRes.status).toBe(200);
		const meta = await metaRes.json() as { cryptoPaymentsEnabled: boolean };
		expect(meta.cryptoPaymentsEnabled).toBe(false);

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		expect(await offersRes.json()).toEqual([]);

		const walletChainsRes = await app.request('/api/account/wallets/link/chains', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(walletChainsRes.status).toBe(200);
		expect(await walletChainsRes.json()).toEqual([]);

		const chainsRes = await app.request('/api/admin/list-payment-chains', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(chainsRes.status).toBe(200);
		const chains = await chainsRes.json() as Array<{ chainId: number; isRpcConfigured: boolean }>;
		expect(chains).toContainEqual(expect.objectContaining({ chainId: 8453, isRpcConfigured: false }));

		const deploymentsRes = await app.request('/api/admin/list-payment-asset-deployments', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(deploymentsRes.status).toBe(200);
		const deployments = await deploymentsRes.json() as Array<{ chainId: number; isRpcConfigured: boolean }>;
		expect(deployments).toContainEqual(expect.objectContaining({ chainId: 8453, isRpcConfigured: false }));

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(orderRes.status).toBe(403);
		const orderError = await orderRes.json() as { error: string };
		expect(orderError.error).toBe('FORBIDDEN');
	});

	test('creating an order is rejected when crypto payments are not acceptable', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		const wallet = await createLinkedWallet(userId);
		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, deploymentId: deployment.id, payerWalletId: wallet.id, quotedAmountBaseUnits: '30000000', quoteCreatedAt: Date.now() }),
		}, env);
		expect(orderRes.status).toBe(403);
		const body = await orderRes.json() as { error: string };
		expect(body.error).toBe('FORBIDDEN');
	});

	test('confirming an existing order is not blocked when crypto payments are disabled after order creation', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify(await createOrderBody(userToken, price.id, deployment.id, wallet.id)),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { id: string };
		await disableCryptoPayments();
		await env.DB.prepare('UPDATE crypto_payment_orders SET expires_at = ? WHERE id = ?').bind(Date.now() - 1_000, order.id).run();

		const confirmRes = await app.request('/api/billing/confirm-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ orderId: order.id, txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
		}, env);
		expect(confirmRes.status).toBe(400);
		const body = await confirmRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_ORDER_EXPIRED');
	});

	test('creating an order rejects the selected chain when its RPC is not configured', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { asset, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments('{"8453":"http://127.0.0.1:9/rpc"}');

		const polygonChainRes = await app.request('/api/admin/create-payment-chain', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				chainId: 137,
				name: 'Polygon',
				nativeCurrencyName: 'MATIC',
				nativeCurrencySymbol: 'MATIC',
				nativeCurrencyDecimals: 18,
				blockExplorerUrl: 'https://polygonscan.com',
				confirmationsRequired: 1,
			}),
		}, env);
		expect(polygonChainRes.status).toBe(200);

		const polygonDeploymentRes = await app.request('/api/admin/create-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				chainId: 137,
				tokenSymbol: 'USDC',
				tokenName: 'USD Coin',
				contractAddress: '0x6666666666666666666666666666666666666666',
				decimals: 6,
				recipientAddress,
			}),
		}, env);
		expect(polygonDeploymentRes.status).toBe(200);
		const polygonDeployment = await polygonDeploymentRes.json() as { id: string };
		const wallet = await createLinkedWallet(userId, 137);

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({
				priceId: price.id,
				deploymentId: polygonDeployment.id,
				payerWalletId: wallet.id,
				quotedAmountBaseUnits: '30000000',
				quoteCreatedAt: Date.now(),
			}),
		}, env);
		expect(orderRes.status).toBe(400);
		const body = await orderRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_CHAIN_RPC_NOT_CONFIGURED');
	});

	test('creating an order auto-confirms a zero payable quote', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { plan, asset, deployment, price } = await createCryptoOffer(adminToken);
		await enableCryptoPayments();
		const wallet = await createLinkedWallet(userId);

		const updateBasePlanRes = await app.request('/api/admin/update-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: plan.id, name: 'Crypto Pro', maxBuckets: 5, sortOrder: 10 }),
		}, env);
		expect(updateBasePlanRes.status).toBe(200);

		const expensivePlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Expensive Plan', maxBuckets: 50, sortOrder: 5 }),
		}, env);
		expect(expensivePlanRes.status).toBe(200);
		const expensivePlan = await expensivePlanRes.json() as { id: string };

		const expensivePriceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				planId: expensivePlan.id,
				amountBaseUnits: '90000000',
				durationDays: 90,
				durationUnit: 'days',
			}),
		}, env);
		expect(expensivePriceRes.status).toBe(200);

		await insertUserPlanAssignmentFixture({
			userId,
			planId: expensivePlan.id,
			expiresAt: Date.now() + 90 * 86_400_000,
			priceAssetId: asset.id,
			priceAmountBaseUnits: '90000000',
		});

		const quote = await getOfferQuote(userToken, price.id, deployment.id);
		expect(quote.payableAmountBaseUnits).toBe('0');
		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify(createOrderBodyWithQuote(price.id, deployment.id, wallet.id, quote)),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { amountBaseUnits: string; status: string; paidAt: number | null };
		expect(order.amountBaseUnits).toBe('0');
		expect(order.status).toBe('paid');
		expect(typeof order.paidAt).toBe('number');
	});
});
