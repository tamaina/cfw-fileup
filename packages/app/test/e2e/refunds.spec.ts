import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { RefundQuote, RefundView } from '../../src/shared/api/refunds';

const a = `0x${'1'.repeat(40)}`;
const b = `0x${'2'.repeat(40)}`;
const token = `0x${'3'.repeat(40)}`;
const requested = Date.now() - 60_123;

function sample(): RefundView {
	return { request: { id: 'refund-browser', userId: 'user-browser', idempotencyKey: 'browser-key', requestedCutoffAt: requested,
																					requestedMode: 'immediate', effectiveCutoffAt: null, adjustmentReason: '', decisionReason: '', actorUserId: null,
																					status: 'requested', version: 0, quote: null, seller: null, createdAt: requested, updatedAt: requested, completedAt: null }, transfers: [] };
}

function sampleQuote(): RefundQuote {
	return { revision: 1, effectiveCutoffAt: requested, assignments: [{ id: 'assignment', startsAt: requested - 1000, expiresAt: requested + 10_000_000 }],
										reviewReasons: [], groups: [a, b].map((payerAddress, i) => ({ id: `group-${i}`, payerAddress, chainId: 1, contractAddress: token,
																																																																								decimals: 6, tokenSymbol: 'USD', chainName: 'Mock chain', amountBaseUnits: String((i + 1) * 1_000_000),
																																																																								lines: [{ id: `line-${i}`, assignmentId: 'assignment', sourceOrder: { id: `original-${i}`, payerAddress, chainId: 1, contractAddress: token, decimals: 6 },
																																																																																		amountBaseUnits: String((i + 1) * 1_000_000), taxName: '消費税', taxRate: '0.1', taxCurrency: 'USD', taxAmountBaseUnits: '90909', taxExcludedAmountBaseUnits: '909091' }],
										})) };
}

async function mockApp(page: Page, admin: boolean, handler: (path: string, body: Record<string, unknown>) => { status?: number; data: unknown }) {
	const user = { id: 'user-browser', username: 'test', isAdmin: admin, isModerator: false, termsAgreedAt: requested,
																hasGoogle: false, hasMisskey: false, hasPassword: true, recentlyAuthenticated: true, email: null, emailVerifiedAt: null };
	await page.addInitScript(user => { localStorage.setItem('cfw_fileup_token', 'browser-test-fixture'); localStorage.setItem('cfw_fileup_user', JSON.stringify(user)); }, user);
	await page.route('**/api/**', async route => {
		const path = new URL(route.request().url()).pathname;
		const body = route.request().method() === 'POST' ? route.request().postDataJSON() as Record<string, unknown> : {};
		const result = path === '/api/account/me' ? { data: user }
			: path === '/api/meta' ? { data: { appName: 'CFW FileUp', reownProjectId: '', walletConnectChainIds: [], cryptoPaymentsEnabled: true } }
			: handler(path, body);
		await route.fulfill({ status: result.status ?? 200, contentType: 'application/json', body: JSON.stringify(result.data) });
	});
}

test('user corrects an invalid date, submits in-app, and sees requested cutoff without recipient editing', async ({ page }) => {
	const attempts: Record<string, unknown>[] = [];
	let views: RefundView[] = [];
	await mockApp(page, false, (path, body) => {
		if (path === '/api/billing/list-my-refund-requests') return { data: views };
		if (path === '/api/billing/create-refund-request') {
			attempts.push(body);
			if (attempts.length === 1) return { status: 400, data: { error: 'REFUND_INVALID', message: '終了希望日時は今以降を指定してください。' } };
			const view = sample(); view.request.requestedCutoffAt = Number(body.requestedCutoffAt); view.request.requestedMode = 'scheduled'; views = [view];
			return { data: view };
		}
		return { data: [] };
	});
	await page.goto('/my/payments'); await page.getByRole('tab', { name: '返金申請' }).click();
	await page.getByLabel('今すぐを終了希望日時にする').uncheck();
	await page.getByLabel('終了希望日時（端末のタイムゾーン）').fill('2020-01-01T12:00');
	await page.getByRole('button', { name: '返金を申請', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('今以降');
	await page.getByLabel('終了希望日時（端末のタイムゾーン）').fill('2090-01-01T12:00');
	await page.getByRole('button', { name: '返金を申請', exact: true }).click();
	await expect(page.getByText('申請 refund-browser')).toBeVisible();
	expect(attempts[0].idempotencyKey).not.toBe(attempts[1].idempotencyKey);
	expect(attempts[0].requestedCutoffAt).not.toBe(attempts[1].requestedCutoffAt);
	await expect(page.getByRole('button', { name: '申請を取消' })).toBeVisible();
	await expect(page.locator('input[placeholder="0x..."]')).toHaveCount(0);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({ path: 'test-results/refund-user.png', fullPage: true });
});

test('admin preserves an aged requested timestamp, recalculates multiple payers, and approves without signing', async ({ page }) => {
	let view = sample(); let quotedAt: unknown;
	await mockApp(page, true, (path, body) => {
		if (path.endsWith('list-refund-requests')) return { data: [view] };
		if (path.endsWith('show-refund-request')) return { data: view };
		if (path.endsWith('quote-refund')) { quotedAt = body.effectiveCutoffAt; return { data: sampleQuote() }; }
		if (path.endsWith('prepare-refund')) {
			view = { ...view, request: { ...view.request, status: 'prepared', version: 1, effectiveCutoffAt: requested, quote: sampleQuote() },
												transfers: sampleQuote().groups.map(group => ({ id: group.id, requestId: view.request.id, chainId: 1, confirmationsRequired: 2, senderAddress: null, txHash: null, status: 'prepared', version: 0, startedAt: null, blockHash: null, blockNumber: null, logIndex: null })) };
			return { data: view };
		}
		return { data: [] };
	});
	await page.goto('/admin/refunds'); await page.getByRole('button', { name: '詳細・返金処理' }).click();
	await page.getByRole('button', { name: '返金額を再計算' }).click();
	expect(quotedAt).toBe(requested);
	await expect(page.getByText(a, { exact: false }).last()).toBeVisible();
	await expect(page.getByText(b, { exact: false }).last()).toBeVisible();
	await page.getByRole('button', { name: '見積を承認して送金準備' }).click();
	await expect(page.getByRole('button', { name: '接続ウォレットから送金' })).toHaveCount(2);
	await expect(page.getByRole('button', { name: '全送金をチェーン確認' })).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({ path: 'test-results/refund-admin.png', fullPage: true });
});

test('completed evidence downloads a real PDF with original order references', async ({ page }) => {
	const view = sample(); view.request.status = 'completed'; view.request.quote = sampleQuote(); view.request.effectiveCutoffAt = requested;
	view.request.completedAt = Date.now(); view.request.seller = { name: '試験販売者', address: '試験住所', invoiceRegistrationNumber: 'TEST' };
	await mockApp(page, false, path => ({ data: path.endsWith('list-my-refund-requests') ? [view] : [] }));
	await page.goto('/my/payments'); await page.getByRole('tab', { name: '返金申請' }).click();
	const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '返金証憑 PDF' }).click();
	const download = await downloaded; expect(download.suggestedFilename()).toBe('refund-refund-browser.pdf');
	await download.saveAs('test-results/refund-proof.pdf');
});

test('browser recovery restores an already broadcast hash and never offers a second send', async ({ page }) => {
	let view = sample(); view.request.status = 'processing'; view.request.quote = sampleQuote(); view.request.effectiveCutoffAt = requested;
	const savedHash = `0x${'8'.repeat(64)}`; let submittedHash: unknown;
	view.transfers = sampleQuote().groups.map((group, index) => ({ id: group.id, requestId: view.request.id, chainId: 1,
																																																																confirmationsRequired: 2, senderAddress: a, txHash: index === 0 ? `0x${'9'.repeat(64)}` : null,
																																																																status: index === 0 ? 'verified' : 'broadcast_pending', version: 1, startedAt: requested, blockHash: null, blockNumber: null, logIndex: null }));
	await page.addInitScript(hash => localStorage.setItem('refund-tx:group-1', hash), savedHash);
	await mockApp(page, true, (path, body) => {
		if (path.endsWith('list-refund-requests')) return { data: [view] };
		if (path.endsWith('show-refund-request')) return { data: view };
		if (path.endsWith('submit-refund-transfer')) {
			submittedHash = body.txHash;
			view = { ...view, transfers: view.transfers.map(transfer => transfer.id === 'group-1' ? { ...transfer, txHash: savedHash, status: 'submitted' } : transfer) };
			return { data: view };
		}
		return { data: [] };
	});
	await page.goto('/admin/refunds'); await page.getByRole('button', { name: '詳細・返金処理' }).click();
	await expect(page.getByRole('button', { name: '接続ウォレットから送金' })).toHaveCount(0);
	await expect(page.getByLabel('送信済み Tx Hash')).toHaveValue(savedHash);
	await page.getByRole('button', { name: 'Tx Hashを登録' }).click();
	expect(submittedHash).toBe(savedHash);
	await expect(page.getByText('チェーン確認待ち', { exact: false })).toBeVisible();
});
