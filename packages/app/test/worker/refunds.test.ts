import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/worker/utils/db';
import { applyFundedPurchase } from '../../src/worker/utils/billing-funding';
import * as billingStateModule from '../../src/worker/utils/billing-state';
import * as quotaModule from '../../src/worker/utils/rate-limit';
import { commitBillingBatch, getBillingState } from '../../src/worker/utils/billing-state';
import { cryptoPaymentOrders, paymentAssetDeployments, paymentAssetPlanPrices, paymentAssets, paymentChains, plans, refundRequests, refundSourceClaims, userPlanAssignments, userWallets } from '../../src/worker/scheme';
import { app, authHeaders, clearDb, env, setupDb, signup } from './helpers';
import type { RefundQuote, RefundView } from '../../src/shared/api/refunds';

const payerA = `0x${'1'.repeat(40)}` as const;
const payerB = `0x${'2'.repeat(40)}` as const;
const token = `0x${'3'.repeat(40)}` as const;
const sender = `0x${'4'.repeat(40)}` as const;
const recipient = `0x${'5'.repeat(40)}` as const;
const blockHash = `0x${'6'.repeat(64)}`;
const transferAbi = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
let adminToken: string;
let userToken: string;
let userId: string;
let adminId: string;
let sequence = 0;

beforeAll(setupDb);
beforeEach(async () => {
	await clearDb(); sequence = 0;
	const admin = await signup('firstuser'); const user = await signup('user1');
	adminToken = String(admin.data.token); adminId = String(admin.data.userId);
	userToken = String(user.data.token); userId = String(user.data.userId);
	await getDb(env).insert(plans).values([
		{ id: 'basic', name: 'Basic', sortOrder: 1, createdAt: Date.now(), updatedAt: Date.now() },
		{ id: 'pro', name: 'Pro', sortOrder: 2, createdAt: Date.now(), updatedAt: Date.now() },
	]);
	await getDb(env).insert(paymentAssets).values({ id: 'mock-usd', symbol: 'USD', name: 'Mock USD', createdAt: Date.now(), updatedAt: Date.now() });
	await getDb(env).insert(paymentChains).values({ chainId: 1, name: 'Local mock chain', nativeCurrencyName: 'Ether', nativeCurrencySymbol: 'ETH', nativeCurrencyDecimals: 18, confirmationsRequired: 2, createdAt: Date.now(), updatedAt: Date.now() });
	Object.assign(env, { EVM_CHAIN_RPC_URLS: JSON.stringify({ 1: 'https://rpc.invalid/1' }) });
});
afterEach(() => vi.restoreAllMocks());

async function post(path: string, body: object, auth = adminToken) {
	return app.request(path, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify(body) }, env);
}

async function api<T>(path: string, body: object, auth = adminToken): Promise<T> {
	const res = await post(path, body, auth);
	if (res.status !== 200) throw new Error(`${path} ${res.status}: ${await res.text()}`);
	return await res.json() as T;
}

async function fund(options: { amount?: string; payer?: string; startsAt?: number; expiresAt?: number; plan?: string; discounts?: string[]; chainId?: number; token?: string; decimals?: number } = {}) {
	const db = getDb(env);
	const now = Date.now(); const state = await getBillingState(env, userId);
	const id = `order-${++sequence}`;
	const startsAt = options.startsAt ?? now + 100_000;
	const expiresAt = options.expiresAt ?? startsAt + 100_000;
	await db.insert(cryptoPaymentOrders).values({
		id, userId, payerAddress: options.payer ?? payerA, planId: options.plan ?? 'basic',
		chainId: options.chainId ?? 1, chainName: 'Local mock chain', tokenSymbol: 'USD', tokenName: 'Mock USD', planName: 'Test plan',
		contractAddress: options.token ?? token, recipientAddress: recipient, amountBaseUnits: options.amount ?? '1000', decimals: options.decimals ?? 6,
		durationDays: 1, quoteCreatedAt: now, quoteExpiresAt: now + 900_000,
		quoteBaseAmountBaseUnits: '1000', quoteDiscountBaseUnits: options.discounts?.length ? '500' : '0',
		quoteEffectiveStartsAt: startsAt, quoteEffectiveExpiresAt: expiresAt, assetId: 'mock-usd',
		quoteDiscountAssignmentIds: JSON.stringify(options.discounts ?? []), billingRevision: state.revision,
		createdAt: now, updatedAt: now, expiresAt: now + 1_800_000,
		taxAmountBaseUnits: '100', taxIncludedAmountBaseUnits: options.amount ?? '1000', taxExcludedAmountBaseUnits: '900',
	});
	const row = await db.select().from(cryptoPaymentOrders).where(eq(cryptoPaymentOrders.id, id)).get();
	if (!row) throw new Error('Missing order');
	await applyFundedPurchase(env, row, now);
	return id;
}

async function purchaseSetup() {
	const db = getDb(env); const now = Date.now();
	await db.insert(userWallets).values({ id: 'wallet', userId, chainId: 1, address: payerA, createdAt: now, updatedAt: now });
	await db.insert(paymentAssetDeployments).values({ id: 'deployment', assetId: 'mock-usd', chainId: 1, tokenSymbol: 'USD', tokenName: 'Mock USD', contractAddress: token, recipientAddress: recipient, decimals: 6, createdAt: now, updatedAt: now });
	await db.insert(paymentAssetPlanPrices).values({ id: 'price', assetId: 'mock-usd', planId: 'basic', amountBaseUnits: '1000', durationDays: 1, startsAt: now - 1000, createdAt: now, updatedAt: now });
	await api('/api/admin/update-setting', { key: 'crypto_payments_enabled', value: 'true' });
	return { priceId: 'price', deploymentId: 'deployment', payerWalletId: 'wallet', quotedAmountBaseUnits: '1000', quoteCreatedAt: now };
}

async function request(cutoffAt: number | null = null, key = `request-${++sequence}`) {
	return api<RefundView>('/api/billing/create-refund-request', { idempotencyKey: key, requestedCutoffAt: cutoffAt }, userToken);
}

async function prepare(view: RefundView, cutoffAt = view.request.requestedCutoffAt) {
	const quote = await api<RefundQuote>('/api/admin/quote-refund', { requestId: view.request.id, effectiveCutoffAt: cutoffAt });
	return api<RefundView>('/api/admin/prepare-refund', { requestId: view.request.id, version: view.request.version,
																																																							effectiveCutoffAt: cutoffAt, adjustmentReason: cutoffAt === view.request.requestedCutoffAt ? '' : '調整', quoteRevision: quote.revision });
}

async function submitAll(view: RefundView) {
	let current = view;
	for (const transfer of view.transfers) {
		current = await api<RefundView>('/api/admin/start-refund-transfer', { requestId: view.request.id, transferId: transfer.id, version: current.request.version, senderAddress: sender });
		current = await api<RefundView>('/api/admin/submit-refund-transfer', { requestId: view.request.id, transferId: transfer.id, txHash: `0x${(++sequence).toString(16).padStart(64, '0')}` });
	}
	return current;
}

function rpc(view: RefundView, options: { pending?: Set<string>; invalid?: boolean; reorgOnFinal?: boolean; insufficient?: boolean; from?: `0x${string}` } = {}) {
	let receiptCalls = 0;
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
		const requestBody = JSON.parse(String(init?.body)) as { id: number; method: string; params?: string[] };
		const transfer = view.transfers.find(item => item.txHash === requestBody.params?.[0]);
		const group = view.request.quote?.groups.find(item => item.id === transfer?.id);
		let result: unknown;
		if (requestBody.method === 'eth_chainId') result = '0x1';
		else if (requestBody.method === 'eth_blockNumber') result = options.insufficient ? '0x64' : '0x65';
		else if (requestBody.method === 'eth_getBlockByNumber') result = { number: '0x64', hash: blockHash, timestamp: `0x${Math.ceil(Date.now() / 1000).toString(16)}`, transactions: [] };
		else if (requestBody.method === 'eth_getTransactionReceipt') {
			receiptCalls++;
			if (!transfer || !group || options.pending?.has(transfer.id) || (options.reorgOnFinal && receiptCalls > view.transfers.length)) result = null;
			else result = {
				transactionHash: transfer.txHash, transactionIndex: '0x0', blockHash, blockNumber: '0x64', from: options.from ?? sender, to: token,
				cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', status: '0x1', type: '0x2', contractAddress: null,
				logs: [{ address: token, data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(group.amountBaseUnits)]),
													topics: encodeEventTopics({ abi: [transferAbi], eventName: 'Transfer', args: { from: options.from ?? sender, to: options.invalid ? recipient : group.payerAddress as `0x${string}` } }),
													blockHash, blockNumber: '0x64', transactionHash: transfer.txHash, transactionIndex: '0x0', logIndex: '0x0', removed: false }],
			};
		} else throw new Error(`Unexpected RPC ${requestBody.method}`);
		return new Response(JSON.stringify({ jsonrpc: '2.0', id: requestBody.id, result }), { headers: { 'Content-Type': 'application/json' } });
	});
}

async function assignmentCount() { return (await env.DB.prepare('SELECT count(*) AS count FROM user_plan_assignments WHERE user_id = ?').bind(userId).first<{ count: number }>())?.count; }

describe('Refund API + D1 integration', () => {
	test('request has no entitlement effect; retry keeps immediate timestamp even after it becomes past', async () => {
		await fund();
		const first = await request(null, 'same-key');
		const second = await request(null, 'same-key');
		expect(second.request.id).toBe(first.request.id);
		expect(second.request.requestedCutoffAt).toBe(first.request.requestedCutoffAt);
		expect(await assignmentCount()).toBe(1);
		expect((await post('/api/billing/create-refund-request', { idempotencyKey: 'same-key', requestedCutoffAt: Date.now() + 1000 }, userToken)).status).toBe(409);
	});
	test('rejects past new requests and duplicate open requests', async () => {
		expect((await post('/api/billing/create-refund-request', { idempotencyKey: 'past', requestedCutoffAt: Date.now() - 1000 }, userToken)).status).toBe(400);
		await request();
		expect((await post('/api/billing/create-refund-request', { idempotencyKey: 'other', requestedCutoffAt: null }, userToken)).status).toBe(409);
	});
	test('enforces ownership, admin-only processing, and rejection reason', async () => {
		const view = await request();
		expect((await post('/api/billing/cancel-refund-request', { requestId: view.request.id, version: 0 }, adminToken)).status).toBe(404);
		expect((await post('/api/admin/quote-refund', { requestId: view.request.id, effectiveCutoffAt: Date.now() }, userToken)).status).toBe(403);
		await api('/api/admin/reject-refund', { requestId: view.request.id, version: 0, reason: '理由' });
		const retry = await api<RefundView>('/api/admin/reject-refund', { requestId: view.request.id, version: 0, reason: '理由' });
		expect(retry.request.status).toBe('rejected'); expect(retry.request.actorUserId).toBe(adminId);
	});
	test('unknown legacy provenance requires review and creates no transfers or lock', async () => {
		await fund(); await env.DB.prepare('UPDATE user_plan_assignments SET refund_provenance_complete = 0').run();
		const result = await prepare(await request());
		expect(result.request.status).toBe('review_required'); expect(result.transfers).toHaveLength(0);
		expect((await getBillingState(env, userId)).lockRequestId).toBeNull(); expect(await assignmentCount()).toBe(1);
	});
	test('immutable source cash is prorated and multiple payers remain separate', async () => {
		const start = Date.now() + 100_000; const end = start + 100_000;
		await fund({ startsAt: start, expiresAt: end, payer: payerA });
		await fund({ startsAt: start, expiresAt: end, payer: payerB });
		const view = await prepare(await request(start + 50_000));
		expect(view.request.quote?.groups.map(group => group.amountBaseUnits)).toEqual(['500', '500']);
		expect(view.request.quote?.groups.map(group => group.payerAddress)).toEqual([payerA, payerB]);
	});
	test('upgrade funding traces original cash and preserves uncredited tail', async () => {
		const start = Date.now() + 100_000; const end = start + 200_000;
		const original = await fund({ startsAt: start, expiresAt: end });
		const [old] = await getDb(env).select().from(userPlanAssignments).where(eq(userPlanAssignments.userId, userId));
		await fund({ amount: '500', payer: payerB, startsAt: start + 50_000, expiresAt: start + 150_000, plan: 'pro', discounts: [old.id] });
		const view = await prepare(await request());
		const groups = view.request.quote?.groups ?? [];
		expect(groups.find(group => group.payerAddress === payerA)?.amountBaseUnits).toBe('1000');
		expect(groups.find(group => group.payerAddress === payerB)?.amountBaseUnits).toBe('500');
		expect(groups[0].lines.every(line => line.sourceOrder.id === original)).toBe(true);
		expect(await assignmentCount()).toBe(3);
	});
	test('prepare locks purchases and admin deletion; cancellation releases the lock', async () => {
		await fund(); const view = await prepare(await request());
		expect((await post('/api/admin/delete-user-plan', { userId })).status).toBe(409);
		await expect(fund()).rejects.toMatchObject({ code: 'REFUND_CONFLICT' });
		const cancelled = await api<RefundView>('/api/billing/cancel-refund-request', { requestId: view.request.id, version: view.request.version }, userToken);
		expect(cancelled.request.status).toBe('cancelled'); expect((await getBillingState(env, userId)).lockRequestId).toBeNull();
		expect(await assignmentCount()).toBe(1);
	});
	test('broadcast intent prevents cancellation and a second wallet send', async () => {
		await fund(); const view = await prepare(await request()); const transfer = view.transfers[0];
		const started = await api<RefundView>('/api/admin/start-refund-transfer', { requestId: view.request.id, version: view.request.version, transferId: transfer.id, senderAddress: sender });
		expect((await post('/api/billing/cancel-refund-request', { requestId: view.request.id, version: started.request.version }, userToken)).status).toBe(409);
		expect((await post('/api/admin/start-refund-transfer', { requestId: view.request.id, version: started.request.version, transferId: transfer.id, senderAddress: sender })).status).toBe(409);
		expect(await assignmentCount()).toBe(1);
	});
	test('partial group confirmation never expires any period; all groups complete exactly once', async () => {
		await fund(); await fund({ payer: payerB });
		const view = await submitAll(await prepare(await request()));
		const mock = rpc(view, { pending: new Set([view.transfers[1].id]) });
		const partial = await api<RefundView>('/api/admin/check-refund', { requestId: view.request.id });
		expect(partial.request.status).toBe('processing'); expect(await assignmentCount()).toBe(2);
		mock.mockRestore(); rpc(view);
		const complete = await api<RefundView>('/api/admin/check-refund', { requestId: view.request.id });
		expect(complete.request.status).toBe('completed'); expect(complete.request.seller).not.toBeNull(); expect(await assignmentCount()).toBe(0);
		const retry = await api<RefundView>('/api/admin/check-refund', { requestId: view.request.id });
		expect(retry).toEqual(complete);
		expect(await getDb(env).select().from(refundSourceClaims)).toHaveLength(2);
	});
	test('invalid Transfer, insufficient confirmations, and final reorg leave entitlement intact', async () => {
		await fund(); const view = await submitAll(await prepare(await request()));
		let mock = rpc(view, { invalid: true });
		expect((await post('/api/admin/check-refund', { requestId: view.request.id })).status).toBe(400);
		mock.mockRestore(); mock = rpc(view, { insufficient: true });
		expect((await api<RefundView>('/api/admin/check-refund', { requestId: view.request.id })).request.status).toBe('processing');
		mock.mockRestore(); rpc(view, { reorgOnFinal: true });
		expect((await api<RefundView>('/api/admin/check-refund', { requestId: view.request.id })).request.status).toBe('processing');
		expect(await assignmentCount()).toBe(1);
	});
	test('failed D1 CAS rolls back every later statement, not only the state update', async () => {
		await fund(); const state = await getBillingState(env, userId);
		await expect(commitBillingBatch(env, { userId, revision: state.revision + 1, lockRequestId: null,
																																									statements: [env.DB.prepare('DELETE FROM user_plan_assignments WHERE user_id = ?').bind(userId)] })).rejects.toMatchObject({ code: 'REFUND_CONFLICT' });
		expect(await assignmentCount()).toBe(1);
	});
	test('stale quote cannot reserve a changed plan schedule', async () => {
		await fund(); const view = await request();
		const quote = await api<RefundQuote>('/api/admin/quote-refund', { requestId: view.request.id, effectiveCutoffAt: view.request.requestedCutoffAt });
		await fund({ payer: payerB });
		expect((await post('/api/admin/prepare-refund', { requestId: view.request.id, version: 0, effectiveCutoffAt: view.request.requestedCutoffAt, adjustmentReason: '', quoteRevision: quote.revision })).status).toBe(409);
		expect((await getBillingState(env, userId)).lockRequestId).toBeNull(); expect(await assignmentCount()).toBe(2);
	});
	test('future partial refunds retain the original denominator across a second earlier cutoff', async () => {
		const startsAt = Date.now() + 100_000; const expiresAt = startsAt + 100_000;
		await fund({ startsAt, expiresAt });
		const first = await submitAll(await prepare(await request(startsAt + 50_000)));
		let mock = rpc(first); await api('/api/admin/check-refund', { requestId: first.request.id }); mock.mockRestore();
		const second = await submitAll(await prepare(await request(startsAt + 25_000)));
		expect(second.request.quote?.groups[0].amountBaseUnits).toBe('250');
		mock = rpc(second); await api('/api/admin/check-refund', { requestId: second.request.id }); mock.mockRestore();
		const claims = await getDb(env).select().from(refundSourceClaims);
		expect(claims.reduce((sum, row) => sum + BigInt(row.amountBaseUnits), 0n)).toBe(750n);
		const [retained] = await getDb(env).select().from(userPlanAssignments);
		expect(retained.expiresAt).toBe(startsAt + 25_000);
	});
	test('repeated hash registration is stable and another group cannot claim the same proof', async () => {
		await fund(); await fund({ payer: payerB });
		const prepared = await prepare(await request());
		let current = prepared; const hash = `0x${'9'.repeat(64)}`;
		for (const transfer of current.transfers) {
			current = await api('/api/admin/start-refund-transfer', { requestId: prepared.request.id, transferId: transfer.id, version: current.request.version, senderAddress: sender });
		}
		const body = { requestId: prepared.request.id, transferId: prepared.transfers[0].id, txHash: hash };
		const one = await api<RefundView>('/api/admin/submit-refund-transfer', body);
		expect(await api('/api/admin/submit-refund-transfer', body)).toEqual(one);
		expect((await post('/api/admin/submit-refund-transfer', { ...body, transferId: prepared.transfers[1].id })).status).toBe(409);
		expect((await post('/api/admin/submit-refund-transfer', { ...body, txHash: `0x${'8'.repeat(64)}` })).status).toBe(409);
	});
	test('simultaneous prepare/cancel has exactly one winner and no orphan lock', async () => {
		await fund(); const view = await request();
		const quote = await api<RefundQuote>('/api/admin/quote-refund', { requestId: view.request.id, effectiveCutoffAt: view.request.requestedCutoffAt });
		const responses = await Promise.all([
			post('/api/admin/prepare-refund', { requestId: view.request.id, version: 0, effectiveCutoffAt: view.request.requestedCutoffAt, adjustmentReason: '', quoteRevision: quote.revision }),
			post('/api/billing/cancel-refund-request', { requestId: view.request.id, version: 0 }, userToken),
		]);
		expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
		const [latest] = await api<RefundView[]>('/api/billing/list-my-refund-requests', {}, userToken);
		const state = await getBillingState(env, userId);
		expect(state.lockRequestId).toBe(latest.request.status === 'prepared' ? latest.request.id : null);
		expect(await assignmentCount()).toBe(1);
	});
	test('stale finalization revision cannot expire a schedule or issue evidence', async () => {
		await fund(); const view = await submitAll(await prepare(await request())); rpc(view);
		await env.DB.prepare('UPDATE billing_states SET revision = revision + 1 WHERE user_id = ?').bind(userId).run();
		expect((await post('/api/admin/check-refund', { requestId: view.request.id })).status).toBe(409);
		expect(await assignmentCount()).toBe(1);
		expect(await getDb(env).select().from(refundSourceClaims)).toHaveLength(0);
		const [latest] = await api<RefundView[]>('/api/billing/list-my-refund-requests', {}, userToken);
		expect(latest.request.completedAt).toBeNull(); expect(latest.request.seller).toBeNull();
	});
	test('parallel purchase API requests create only one pending order before either wallet can send', async () => {
		const body = await purchaseSetup();
		const responses = await Promise.all([post('/api/billing/create-crypto-order', body, userToken), post('/api/billing/create-crypto-order', body, userToken)]);
		expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
		expect(await getDb(env).select().from(cryptoPaymentOrders)).toHaveLength(1);
	});
	test('prepare and purchase creation cannot both win the same billing state', async () => {
		await fund(); const body = await purchaseSetup(); const view = await request();
		const quote = await api<RefundQuote>('/api/admin/quote-refund', { requestId: view.request.id, effectiveCutoffAt: view.request.requestedCutoffAt });
		const responses = await Promise.all([
			post('/api/admin/prepare-refund', { requestId: view.request.id, version: 0, effectiveCutoffAt: view.request.requestedCutoffAt, adjustmentReason: '', quoteRevision: quote.revision }),
			post('/api/billing/create-crypto-order', body, userToken),
		]);
		expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
	});
	test('same original payer has separate chain, contract, and decimal transfer groups', async () => {
		await fund(); await fund({ chainId: 10 }); await fund({ token: recipient }); await fund({ decimals: 18 });
		await getDb(env).insert(paymentChains).values({ chainId: 10, name: 'Mock second chain', nativeCurrencyName: 'Ether', nativeCurrencySymbol: 'ETH', nativeCurrencyDecimals: 18, confirmationsRequired: 3, createdAt: Date.now(), updatedAt: Date.now() });
		const view = await prepare(await request());
		expect(view.transfers).toHaveLength(4);
		expect(view.request.quote?.groups.every(group => group.payerAddress === payerA)).toBe(true);
		expect(view.transfers.find(transfer => transfer.chainId === 10)?.confirmationsRequired).toBe(3);
	});
	test('D1 failure after a deletion rolls the entire operation back', async () => {
		await fund(); const state = await getBillingState(env, userId);
		await expect(commitBillingBatch(env, { userId, revision: state.revision, lockRequestId: null,
																																									statements: [env.DB.prepare('DELETE FROM user_plan_assignments WHERE user_id = ?').bind(userId), env.DB.prepare('INSERT INTO nonexistent_refund_table VALUES (1)')] })).rejects.toThrow();
		expect(await assignmentCount()).toBe(1);
	});
	test('pagination and show routes preserve access to an older request and enforce its owner', async () => {
		const db = getDb(env); const now = Date.now();
		for (let i = 0; i < 105; i++) await db.insert(refundRequests).values({ id: `history-${i.toString().padStart(4, '0')}`, userId, idempotencyKey: `key-${i}`, requestedMode: 'immediate', requestedCutoffAt: now, createdAt: now, updatedAt: now, status: 'cancelled' });
		const first = await api<RefundView[]>('/api/billing/list-my-refund-requests', {}, userToken);
		const second = await api<RefundView[]>('/api/billing/list-my-refund-requests', { cursor: first.at(-1)?.request.id }, userToken);
		expect(first).toHaveLength(100); expect(second).toHaveLength(5);
		expect((await api<RefundView>('/api/billing/show-refund-request', { requestId: 'history-0000' }, userToken)).request.id).toBe('history-0000');
		expect((await post('/api/billing/show-refund-request', { requestId: 'history-0000' }, adminToken)).status).toBe(404);
	});
	test('refund invalidates cached quota even if post-commit refresh fails', async () => {
		await fund(); const view = await submitAll(await prepare(await request())); rpc(view);
		await env.DB.prepare('UPDATE users SET effective_quota_updated_at = ?, effective_quota_source = \'plan\', effective_max_buckets = 999 WHERE id = ?').bind(Date.now(), userId).run();
		const refresh = vi.spyOn(quotaModule, 'refreshEffectiveQuotaForUser').mockRejectedValue(new Error('Injected quota refresh failure'));
		const result = await api<RefundView>('/api/admin/check-refund', { requestId: view.request.id });
		expect(result.request.status).toBe('completed');
		const cached = await env.DB.prepare('SELECT effective_quota_updated_at AS updated FROM users WHERE id = ?').bind(userId).first<{ updated: number | null }>();
		expect(cached?.updated).toBeNull(); refresh.mockRestore();
		expect((await quotaModule.getEffectiveQuotaForUser(env, userId)).maxBuckets).not.toBe(999);
	});
	test('an old quota calculation cannot write over a newer billing revision', async () => {
		await fund();
		const original = billingStateModule.getBillingState;
		vi.spyOn(billingStateModule, 'getBillingState').mockImplementation(async (targetEnv, id) => {
			const state = await original(targetEnv, id);
			await targetEnv.DB.prepare('UPDATE billing_states SET revision = revision + 1 WHERE user_id = ?').bind(id).run();
			return state;
		});
		await expect(quotaModule.refreshEffectiveQuotaForUser(env, userId)).rejects.toMatchObject({ code: 'REFUND_CONFLICT' });
		const cached = await env.DB.prepare('SELECT effective_quota_updated_at AS updated FROM users WHERE id = ?').bind(userId).first<{ updated: number | null }>();
		expect(cached?.updated).toBeNull();
	});
	test('credit provenance survives a second upgrade across two original payers', async () => {
		const db = getDb(env); const start = Date.now() + 100_000;
		await db.insert(plans).values({ id: 'ultra', name: 'Ultra', sortOrder: 3, createdAt: Date.now(), updatedAt: Date.now() });
		await fund({ startsAt: start, expiresAt: start + 200_000 });
		const [basic] = await db.select().from(userPlanAssignments).where(eq(userPlanAssignments.planId, 'basic'));
		await fund({ amount: '500', payer: payerB, startsAt: start + 50_000, expiresAt: start + 150_000, plan: 'pro', discounts: [basic.id] });
		const [pro] = await db.select().from(userPlanAssignments).where(eq(userPlanAssignments.planId, 'pro'));
		await fund({ amount: '500', startsAt: start + 80_000, expiresAt: start + 120_000, plan: 'ultra', discounts: [pro.id] });
		const view = await prepare(await request());
		expect(view.request.quote?.groups.find(group => group.payerAddress === payerA)?.amountBaseUnits).toBe('1500');
		expect(view.request.quote?.groups.find(group => group.payerAddress === payerB)?.amountBaseUnits).toBe('500');
	});
	test('parallel registrations of the same group/hash return the same submitted result', async () => {
		await fund(); const prepared = await prepare(await request()); const transferId = prepared.transfers[0].id;
		await api('/api/admin/start-refund-transfer', { requestId: prepared.request.id, transferId, version: prepared.request.version, senderAddress: sender });
		const body = { requestId: prepared.request.id, transferId, txHash: `0x${'7'.repeat(64)}` };
		const responses = await Promise.all([post('/api/admin/submit-refund-transfer', body), post('/api/admin/submit-refund-transfer', body)]);
		expect(responses.map(response => response.status)).toEqual([200, 200]);
		expect(await responses[0].json()).toEqual(await responses[1].json());
	});
	test('parallel purchase confirmations create one paid assignment and one original funding lot', async () => {
		const purchase = await api<typeof cryptoPaymentOrders.$inferSelect>('/api/billing/create-crypto-order', await purchaseSetup(), userToken);
		const view = await request(); const hash = `0x${'a'.repeat(64)}`;
		view.request.quote = { revision: 0, effectiveCutoffAt: Date.now(), assignments: [], reviewReasons: [], groups: [{ id: 'purchase-proof', payerAddress: recipient,
																																																																																																																				chainId: 1, contractAddress: token, decimals: 6, amountBaseUnits: '1000', tokenSymbol: 'USD', chainName: 'Mock', lines: [] }] };
		view.transfers = [{ id: 'purchase-proof', requestId: view.request.id, chainId: 1, confirmationsRequired: 2,
																						senderAddress: payerA, txHash: hash, status: 'submitted', version: 0, startedAt: purchase.createdAt, blockHash: null, blockNumber: null, logIndex: null }];
		rpc(view, { from: payerA });
		const body = { orderId: purchase.id, txHash: hash };
		const responses = await Promise.all([post('/api/billing/confirm-crypto-order', body, userToken), post('/api/billing/confirm-crypto-order', body, userToken)]);
		expect(responses.map(response => response.status)).toEqual([200, 200]);
		expect(await responses[0].json()).toEqual(await responses[1].json());
		expect(await assignmentCount()).toBe(1);
		expect((await env.DB.prepare('SELECT count(*) AS count FROM plan_funding_lots WHERE source_order_id = ?').bind(purchase.id).first<{ count: number }>())?.count).toBe(1);
	});
});
