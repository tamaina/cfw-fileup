import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { getWorkerCacheName, workerCacheBaseNames } from '../../src/worker/utils/cache-names';
import { env, app, setupDb, clearDb, signup, signin, authHeaders } from './helpers';

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
			{ path: '/api/admin/delete-plan', body: { planId: 'x' } },
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
	test('admin can make another user an admin', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();

		const res = await app.request('/api/admin/make-admin', {
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
		const users = await listRes.json() as { items: Array<{ id: string; isAdmin: boolean }> };
		expect(users.items.find((user) => user.id === userId)?.isAdmin).toBe(true);

		const promotedAdminRes = await app.request('/api/admin/get-global-quota', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(promotedAdminRes.status).toBe(200);
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

	test('admin can create, update, list, assign, unassign, and delete a plan', async () => {
		const { adminToken, userId } = await setupAdminAndUser();
		const expiresAt = Date.now() + 86_400_000;

		const createRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Pro', maxBuckets: 10, maxDailyUploads: 100 }),
		}, env);
		expect(createRes.status).toBe(200);
		const created = await createRes.json() as { id: string; name: string; maxBuckets: number };
		expect(created.name).toBe('Pro');
		expect(created.maxBuckets).toBe(10);

		const updateRes = await app.request('/api/admin/update-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: created.id, name: 'Pro Plus', maxBuckets: 12, maxDailyUploads: 120 }),
		}, env);
		expect(updateRes.status).toBe(200);

		const listRes = await app.request('/api/admin/list-plans', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(listRes.status).toBe(200);
		const plans = await listRes.json() as Array<{ id: string; name: string }>;
		expect(plans).toContainEqual(expect.objectContaining({ id: created.id, name: 'Pro Plus' }));

		const assignRes = await app.request('/api/admin/assign-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, planId: created.id, expiresAt }),
		}, env);
		expect(assignRes.status).toBe(200);

		const assignmentRes = await app.request('/api/admin/get-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(assignmentRes.status).toBe(200);
		const assignment = await assignmentRes.json() as { planId: string; planName: string; expiresAt: number };
		expect(assignment.planId).toBe(created.id);
		expect(assignment.planName).toBe('Pro Plus');
		expect(assignment.expiresAt).toBe(expiresAt);

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

		const deleteRes = await app.request('/api/admin/delete-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: created.id }),
		}, env);
		expect(deleteRes.status).toBe(200);
	});

	test('active plan quota overrides per-user quota', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();

		await app.request('/api/admin/set-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, maxBuckets: 1 }),
		}, env);
		const createPlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Pro', maxBuckets: 2 }),
		}, env);
		const plan = await createPlanRes.json() as { id: string };
		await app.request('/api/admin/assign-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, planId: plan.id, expiresAt: Date.now() + 86_400_000 }),
		}, env);

		const first = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_1' }),
		}, env);
		expect(first.status).toBe(200);
		const second = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_2' }),
		}, env);
		expect(second.status).toBe(200);
		const third = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_3' }),
		}, env);
		expect(third.status).toBe(429);
	});

	test('plan quota update propagates to assigned users', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();

		const createPlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Pro', maxBuckets: 2 }),
		}, env);
		const plan = await createPlanRes.json() as { id: string };
		await app.request('/api/admin/assign-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, planId: plan.id, expiresAt: Date.now() + 86_400_000 }),
		}, env);

		const first = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_1' }),
		}, env);
		expect(first.status).toBe(200);

		const updateRes = await app.request('/api/admin/update-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ planId: plan.id, name: 'Pro', maxBuckets: 1 }),
		}, env);
		expect(updateRes.status).toBe(200);

		const quotaRes = await app.request('/api/admin/get-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId }),
		}, env);
		expect(quotaRes.status).toBe(200);
		const quota = await quotaRes.json() as Record<string, unknown>;
		expect(quota.maxBuckets).toBe(1);

		const second = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_2' }),
		}, env);
		expect(second.status).toBe(429);
	});

	test('expired plan quota is ignored and falls back to per-user quota', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();

		await app.request('/api/admin/set-user-quota', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, maxBuckets: 1 }),
		}, env);
		const createPlanRes = await app.request('/api/admin/create-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ name: 'Expired Pro', maxBuckets: 2 }),
		}, env);
		const plan = await createPlanRes.json() as { id: string };
		await app.request('/api/admin/assign-user-plan', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ userId, planId: plan.id, expiresAt: Date.now() - 1_000 }),
		}, env);

		const first = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_1' }),
		}, env);
		expect(first.status).toBe(200);
		const second = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ bucketName: 'bucket_2' }),
		}, env);
		expect(second.status).toBe(429);
	});
});

describe('Crypto payment administration', () => {
	const contractAddress = '0x1111111111111111111111111111111111111111';
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
			body: JSON.stringify({ symbol: 'USDC', name: 'USD Coin' }),
		}, env);
		expect(assetRes.status).toBe(200);
		const asset = await assetRes.json() as { id: string };

		const deploymentRes = await app.request('/api/admin/create-payment-asset-deployment', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				assetId: asset.id,
				chainId: 8453,
				contractAddress,
				decimals: 6,
				recipientAddress,
			}),
		}, env);
		expect(deploymentRes.status).toBe(200);
		const deployment = await deploymentRes.json() as { id: string };

		const priceRes = await app.request('/api/admin/create-payment-asset-plan-price', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({
				deploymentId: deployment.id,
				planId: plan.id,
				amountBaseUnits: '30000000',
				durationDays: 90,
			}),
		}, env);
		expect(priceRes.status).toBe(200);
		const price = await priceRes.json() as { id: string };
		return { plan, asset, deployment, price };
	}

	async function createLinkedWallet(userId: string, chainId = 8453, address = '0x3333333333333333333333333333333333333333') {
		const now = Date.now();
		const id = `wallet-${now}-${Math.random()}`;
		await env.DB.prepare(
			'INSERT INTO user_wallets (id, user_id, chain_id, address, label, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
		).bind(id, userId, chainId, address, now, now).run();
		return { id, chainId, address };
	}

	test('admin can create chain, asset, deployment, and plan price', async () => {
		const { adminToken } = await setupAdminAndUser();
		const { price } = await createCryptoOffer(adminToken);

		const listRes = await app.request('/api/admin/list-payment-asset-plan-prices', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({}),
		}, env);
		expect(listRes.status).toBe(200);
		const prices = await listRes.json() as Array<{ id: string; assetSymbol: string; chainId: number; amountBaseUnits: string }>;
		expect(prices).toContainEqual(expect.objectContaining({
			id: price.id,
			assetSymbol: 'USDC',
			chainId: 8453,
			amountBaseUnits: '30000000',
		}));
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
				contractAddress,
				decimals: 6,
				recipientAddress,
			}),
		}, env);
		expect(duplicateRes.status).toBe(400);
		const body = await duplicateRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_ASSET_DEPLOYMENT_ALREADY_EXISTS');
	});

	test('user can list offers and create an order with a price snapshot', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { price } = await createCryptoOffer(adminToken);
		const wallet = await createLinkedWallet(userId);

		const offersRes = await app.request('/api/billing/list-crypto-offers', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({}),
		}, env);
		expect(offersRes.status).toBe(200);
		const offers = await offersRes.json() as Array<{ id: string; assetSymbol: string; chainName: string }>;
		expect(offers).toContainEqual(expect.objectContaining({ id: price.id, assetSymbol: 'USDC', chainName: 'Base' }));

		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, payerWalletId: wallet.id }),
		}, env);
		expect(orderRes.status).toBe(200);
		const order = await orderRes.json() as { amountBaseUnits: string; chainId: number; contractAddress: string; recipientAddress: string; payerAddress: string; status: string };
		expect(order).toMatchObject({
			amountBaseUnits: '30000000',
			chainId: 8453,
			contractAddress,
			payerAddress: wallet.address,
			recipientAddress,
			status: 'pending',
		});
	});

	test('confirming an order rejects missing RPC configuration', async () => {
		const { adminToken, userToken, userId } = await setupAdminAndUser();
		const { price } = await createCryptoOffer(adminToken);
		const wallet = await createLinkedWallet(userId);
		const orderRes = await app.request('/api/billing/create-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ priceId: price.id, payerWalletId: wallet.id }),
		}, env);
		const order = await orderRes.json() as { id: string };

		const confirmRes = await app.request('/api/billing/confirm-crypto-order', {
			method: 'POST',
			headers: authHeaders(userToken),
			body: JSON.stringify({ orderId: order.id, txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
		}, env);
		expect(confirmRes.status).toBe(400);
		const body = await confirmRes.json() as { error: string };
		expect(body.error).toBe('PAYMENT_CHAIN_RPC_NOT_CONFIGURED');
	});
});
