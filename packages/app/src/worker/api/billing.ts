import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { and, asc, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { calculatePaymentQuote, type PaymentDurationUnit, type PaymentQuote } from '../../shared/billing-quote';
import { authMiddleware } from '../middleware/auth';
import { cryptoPaymentOrders, paymentAssetDeployments, paymentAssetPlanPrices, paymentAssets, paymentChains, plans, userPlanAssignments, userWallets } from '../scheme/index';
import { checkCryptoPaymentOrder, confirmCryptoPaymentOrder, getCryptoPaymentOrderExpiresAt } from '../utils/billing';
import { apiError } from '../utils/api-error';
import { canAcceptCryptoPayments } from '../utils/crypto-payments';
import { getDb } from '../utils/db';
import { recordModerationEvent } from '../utils/moderation';
import { omitResAndReq } from '../utils/omit';
import { idPage, pageParams } from '../utils/pagination';
import { isPaymentChainRpcConfigured } from '../utils/payment-rpc';
import { genEaidx } from '../../shared/eaid-x';

const app = new Hono<{ Bindings: Env }>();
const QUOTE_TTL_MS = 15 * 60 * 1000;

app.use(authMiddleware);

async function createPaymentOfferQuote(env: Env, userId: string, offer: {
	assetId: string;
	planId: string;
	planName: string;
	amountBaseUnits: string;
	durationDays: number;
	durationUnit: PaymentDurationUnit;
}, quoteCreatedAt: number): Promise<PaymentQuote> {
	const db = getDb(env);
	const activeAssignment = await db
		.select({
			planId: userPlanAssignments.planId,
			expiresAt: userPlanAssignments.expiresAt,
			planName: plans.name,
		})
		.from(userPlanAssignments)
		.innerJoin(plans, eq(userPlanAssignments.planId, plans.id))
		.where(and(eq(userPlanAssignments.userId, userId), gt(userPlanAssignments.expiresAt, quoteCreatedAt)))
		.get();
	const currentPlanPrice = activeAssignment && activeAssignment.planId !== offer.planId
		? await getReferencePlanPrice(env, offer.assetId, activeAssignment.planId, quoteCreatedAt)
		: null;
	const currentPlan = activeAssignment && activeAssignment.planId === offer.planId
		? {
			id: activeAssignment.planId,
			name: activeAssignment.planName,
			expiresAt: activeAssignment.expiresAt,
			price: {
				amountBaseUnits: offer.amountBaseUnits,
				durationDays: offer.durationDays,
				durationUnit: offer.durationUnit,
			},
		}
		: activeAssignment && currentPlanPrice ? {
			id: activeAssignment.planId,
			name: activeAssignment.planName,
			expiresAt: activeAssignment.expiresAt,
			price: currentPlanPrice,
		} : null;
	return calculatePaymentQuote({
		quoteCreatedAt,
		quoteTtlMs: QUOTE_TTL_MS,
		targetPlanId: offer.planId,
		targetPlanPrice: {
			amountBaseUnits: offer.amountBaseUnits,
			durationDays: offer.durationDays,
			durationUnit: offer.durationUnit,
		},
		currentPlan,
	});
}

async function getReferencePlanPrice(env: Env, assetId: string, planId: string, quoteCreatedAt: number) {
	const currentPlanPrices = await getDb(env)
		.select({
			amountBaseUnits: paymentAssetPlanPrices.amountBaseUnits,
			durationDays: paymentAssetPlanPrices.durationDays,
			durationUnit: paymentAssetPlanPrices.durationUnit,
			expiresAt: paymentAssetPlanPrices.expiresAt,
			createdAt: paymentAssetPlanPrices.createdAt,
		})
		.from(paymentAssetPlanPrices)
		.where(and(
			eq(paymentAssetPlanPrices.assetId, assetId),
			eq(paymentAssetPlanPrices.planId, planId),
		));
	const activePrices = currentPlanPrices.filter(price => price.expiresAt == null || price.expiresAt > quoteCreatedAt);
	const price = (activePrices.length > 0 ? activePrices : currentPlanPrices)
		.sort((a, b) => (b.expiresAt ?? Number.MAX_SAFE_INTEGER) - (a.expiresAt ?? Number.MAX_SAFE_INTEGER) || b.createdAt - a.createdAt)[0];
	return price ? {
		amountBaseUnits: price.amountBaseUnits,
		durationDays: price.durationDays,
		durationUnit: price.durationUnit,
	} : null;
}

async function listEnabledOffers(env: Env, userId: string, quoteCreatedAt = Date.now()) {
	const db = getDb(env);
	const rows = await db
		.select({
			id: paymentAssetPlanPrices.id,
			deploymentId: paymentAssetDeployments.id,
			assetId: paymentAssets.id,
			assetSymbol: paymentAssets.symbol,
			assetName: paymentAssets.name,
			tokenSymbol: paymentAssetDeployments.tokenSymbol,
			tokenName: paymentAssetDeployments.tokenName,
			chainId: paymentChains.chainId,
			chainName: paymentChains.name,
			confirmationsRequired: paymentChains.confirmationsRequired,
			contractAddress: paymentAssetDeployments.contractAddress,
			recipientAddress: paymentAssetDeployments.recipientAddress,
			decimals: paymentAssetDeployments.decimals,
			planId: plans.id,
			planName: plans.name,
			planMaxBuckets: plans.maxBuckets,
			planMaxBucketSizeBytes: plans.maxBucketSizeBytes,
			planMaxFilesPerBucket: plans.maxFilesPerBucket,
			planMaxDailyUploads: plans.maxDailyUploads,
			planCanUseDownloadCount: plans.canUseDownloadCount,
			planSortOrder: plans.sortOrder,
			amountBaseUnits: paymentAssetPlanPrices.amountBaseUnits,
			durationDays: paymentAssetPlanPrices.durationDays,
			durationUnit: paymentAssetPlanPrices.durationUnit,
			isEnabled: paymentAssetPlanPrices.isEnabled,
			expiresAt: paymentAssetPlanPrices.expiresAt,
			createdAt: paymentAssetPlanPrices.createdAt,
			updatedAt: paymentAssetPlanPrices.updatedAt,
		})
		.from(paymentAssetPlanPrices)
		.innerJoin(paymentAssets, eq(paymentAssetPlanPrices.assetId, paymentAssets.id))
		.innerJoin(paymentAssetDeployments, eq(paymentAssetDeployments.assetId, paymentAssets.id))
		.innerJoin(paymentChains, eq(paymentAssetDeployments.chainId, paymentChains.chainId))
		.innerJoin(plans, eq(paymentAssetPlanPrices.planId, plans.id))
		.where(and(
			eq(paymentAssetPlanPrices.isEnabled, true),
			eq(paymentAssetDeployments.isEnabled, true),
			eq(paymentAssets.isEnabled, true),
			eq(paymentChains.isEnabled, true),
			eq(plans.isEnabled, true),
			or(isNull(paymentAssetPlanPrices.expiresAt), gt(paymentAssetPlanPrices.expiresAt, Date.now())),
		))
		.orderBy(
			asc(plans.sortOrder),
			asc(plans.createdAt),
			asc(plans.id),
			asc(paymentAssetPlanPrices.durationUnit),
			asc(paymentAssetPlanPrices.durationDays),
			asc(paymentAssetPlanPrices.amountBaseUnits),
			desc(paymentAssetPlanPrices.id),
		);

	return await Promise.all(rows.map(async row => ({
		id: row.id,
		deploymentId: row.deploymentId,
		assetId: row.assetId,
		assetSymbol: row.assetSymbol,
		assetName: row.assetName,
		tokenSymbol: row.tokenSymbol,
		tokenName: row.tokenName,
		chainId: row.chainId,
		chainName: row.chainName,
		confirmationsRequired: row.confirmationsRequired,
		contractAddress: row.contractAddress,
		recipientAddress: row.recipientAddress,
		decimals: row.decimals,
		plan: {
			id: row.planId,
			name: row.planName,
			maxBuckets: row.planMaxBuckets,
			maxBucketSizeBytes: row.planMaxBucketSizeBytes,
			maxFilesPerBucket: row.planMaxFilesPerBucket,
			maxDailyUploads: row.planMaxDailyUploads,
			canUseDownloadCount: row.planCanUseDownloadCount,
			sortOrder: row.planSortOrder,
		},
		amountBaseUnits: row.amountBaseUnits,
		durationDays: row.durationDays,
		durationUnit: row.durationUnit,
		isEnabled: row.isEnabled,
		expiresAt: row.expiresAt,
		isRpcConfigured: isPaymentChainRpcConfigured(env, row.chainId),
		quote: await createPaymentOfferQuote(env, userId, {
			assetId: row.assetId,
			planId: row.planId,
			planName: row.planName,
			amountBaseUnits: row.amountBaseUnits,
			durationDays: row.durationDays,
			durationUnit: row.durationUnit,
		}, quoteCreatedAt),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})));
}

app.post(
	'/list-crypto-offers',
	describeRoute(omitResAndReq(apiDef['/api/billing/list-crypto-offers'])),
	validator('json', apiDef['/api/billing/list-crypto-offers'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/list-crypto-offers', Env>) => {
		if (!await canAcceptCryptoPayments(c.env)) return c.json([], 200);
		return c.json(await listEnabledOffers(c.env, c.get('user').id), 200);
	}, getResponseDefWithAuth('/api/billing/list-crypto-offers')),
);

app.post(
	'/create-crypto-order',
	describeRoute(omitResAndReq(apiDef['/api/billing/create-crypto-order'])),
	validator('json', apiDef['/api/billing/create-crypto-order'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/create-crypto-order', Env>) => {
		if (!await canAcceptCryptoPayments(c.env)) throw apiError(403, 'FORBIDDEN');
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const wallet = await db
			.select({ id: userWallets.id, chainId: userWallets.chainId, address: userWallets.address })
			.from(userWallets)
			.where(and(eq(userWallets.id, body.payerWalletId), eq(userWallets.userId, user.id)))
			.get();
		if (!wallet) throw apiError(400, 'WALLET_NOT_FOUND');

		const price = await db
			.select({
				priceId: paymentAssetPlanPrices.id,
				deploymentId: paymentAssetDeployments.id,
				planId: plans.id,
				assetId: paymentAssets.id,
				chainId: paymentChains.chainId,
				chainName: paymentChains.name,
				assetSymbol: paymentAssets.symbol,
				assetName: paymentAssets.name,
				tokenSymbol: paymentAssetDeployments.tokenSymbol,
				tokenName: paymentAssetDeployments.tokenName,
				contractAddress: paymentAssetDeployments.contractAddress,
				recipientAddress: paymentAssetDeployments.recipientAddress,
				amountBaseUnits: paymentAssetPlanPrices.amountBaseUnits,
				decimals: paymentAssetDeployments.decimals,
				durationDays: paymentAssetPlanPrices.durationDays,
				durationUnit: paymentAssetPlanPrices.durationUnit,
				expiresAt: paymentAssetPlanPrices.expiresAt,
				planName: plans.name,
			})
			.from(paymentAssetPlanPrices)
			.innerJoin(paymentAssets, eq(paymentAssetPlanPrices.assetId, paymentAssets.id))
			.innerJoin(paymentAssetDeployments, eq(paymentAssetDeployments.assetId, paymentAssets.id))
			.innerJoin(paymentChains, eq(paymentAssetDeployments.chainId, paymentChains.chainId))
			.innerJoin(plans, eq(paymentAssetPlanPrices.planId, plans.id))
			.where(and(
				eq(paymentAssetPlanPrices.id, body.priceId),
				eq(paymentAssetDeployments.id, body.deploymentId),
				eq(paymentAssetDeployments.chainId, wallet.chainId),
				eq(paymentAssetPlanPrices.isEnabled, true),
				eq(paymentAssetDeployments.isEnabled, true),
				eq(paymentAssets.isEnabled, true),
				eq(paymentChains.isEnabled, true),
				eq(plans.isEnabled, true),
				or(isNull(paymentAssetPlanPrices.expiresAt), gt(paymentAssetPlanPrices.expiresAt, Date.now())),
			))
			.get();
		if (!price) throw apiError(404, 'PAYMENT_PRICE_NOT_FOUND');
		if (wallet.chainId !== price.chainId) throw apiError(400, 'WALLET_NOT_FOUND');
		if (!isPaymentChainRpcConfigured(c.env, price.chainId)) throw apiError(400, 'PAYMENT_CHAIN_RPC_NOT_CONFIGURED');

		const now = Date.now();
		if (body.quoteCreatedAt > now + 60_000 || now - body.quoteCreatedAt > QUOTE_TTL_MS) {
			throw apiError(400, 'PAYMENT_QUOTE_EXPIRED');
		}
		const quote = await createPaymentOfferQuote(c.env, user.id, {
			assetId: price.assetId,
			planId: price.planId,
			planName: price.planName,
			amountBaseUnits: price.amountBaseUnits,
			durationDays: price.durationDays,
			durationUnit: price.durationUnit,
		}, body.quoteCreatedAt);
		if (quote.payableAmountBaseUnits !== body.quotedAmountBaseUnits) {
			throw apiError(400, 'PAYMENT_QUOTE_INVALID');
		}
		if (BigInt(quote.payableAmountBaseUnits) <= 0n) {
			throw apiError(400, 'PAYMENT_QUOTE_INVALID');
		}
		const order = {
			id: genEaidx(now),
			userId: user.id,
			payerWalletId: wallet.id,
			payerAddress: wallet.address,
			priceId: price.priceId,
			deploymentId: price.deploymentId,
			planId: price.planId,
			assetId: price.assetId,
			chainId: price.chainId,
			chainName: price.chainName,
			assetSymbol: price.tokenSymbol,
			assetName: price.tokenName,
			planName: price.planName,
			contractAddress: price.contractAddress,
			recipientAddress: price.recipientAddress,
			amountBaseUnits: quote.payableAmountBaseUnits,
			decimals: price.decimals,
			durationDays: price.durationDays,
			durationUnit: price.durationUnit,
			quoteCreatedAt: quote.quoteCreatedAt,
			quoteExpiresAt: quote.quoteExpiresAt,
			quoteBaseAmountBaseUnits: quote.baseAmountBaseUnits,
			quoteDiscountBaseUnits: quote.discountBaseUnits,
			quoteEffectiveExpiresAt: quote.effectiveExpiresAt,
			quoteCurrentPlanId: quote.currentPlan?.id ?? null,
			quoteCurrentPlanName: quote.currentPlan?.name ?? null,
			quoteCurrentPlanExpiresAt: quote.currentPlan?.expiresAt ?? null,
			quoteCurrentPlanPriceAmountBaseUnits: quote.currentPlan?.priceAmountBaseUnits ?? null,
			quoteCurrentPlanPriceDurationDays: quote.currentPlan?.priceDurationDays ?? null,
			quoteCurrentPlanPriceDurationUnit: quote.currentPlan?.priceDurationUnit ?? null,
			status: 'pending' as const,
			txHash: null,
			createdAt: now,
			updatedAt: now,
			expiresAt: getCryptoPaymentOrderExpiresAt(now),
			paidAt: null,
		};
		await db.insert(cryptoPaymentOrders).values(order);
		return c.json(order, 200);
	}, getResponseDefWithAuth('/api/billing/create-crypto-order')),
);

app.post(
	'/confirm-crypto-order',
	describeRoute(omitResAndReq(apiDef['/api/billing/confirm-crypto-order'])),
	validator('json', apiDef['/api/billing/confirm-crypto-order'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/confirm-crypto-order', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const before = await db
			.select({ status: cryptoPaymentOrders.status })
			.from(cryptoPaymentOrders)
			.where(and(eq(cryptoPaymentOrders.id, body.orderId), eq(cryptoPaymentOrders.userId, user.id)))
			.get();
		const order = await confirmCryptoPaymentOrder(c.env, user.id, body.orderId, body.txHash);
		if (before?.status !== 'paid' && order.status === 'paid') await recordModerationEvent(c, 'crypto_payment_order_confirmed', { orderId: order.id, chainId: order.chainId, txHash: order.txHash }, user.id, user.tokenId);
		return c.json(order, 200);
	}, getResponseDefWithAuth('/api/billing/confirm-crypto-order')),
);

app.post(
	'/check-crypto-order',
	describeRoute(omitResAndReq(apiDef['/api/billing/check-crypto-order'])),
	validator('json', apiDef['/api/billing/check-crypto-order'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/check-crypto-order', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const before = await db
			.select({ status: cryptoPaymentOrders.status })
			.from(cryptoPaymentOrders)
			.where(and(eq(cryptoPaymentOrders.id, body.orderId), eq(cryptoPaymentOrders.userId, user.id)))
			.get();
		const order = await checkCryptoPaymentOrder(c.env, user.id, body.orderId);
		if (before?.status !== 'paid' && order.status === 'paid') await recordModerationEvent(c, 'crypto_payment_order_confirmed', { orderId: order.id, chainId: order.chainId, txHash: order.txHash }, user.id, user.tokenId);
		return c.json(order, 200);
	}, getResponseDefWithAuth('/api/billing/check-crypto-order')),
);

app.post(
	'/cancel-crypto-order',
	describeRoute(omitResAndReq(apiDef['/api/billing/cancel-crypto-order'])),
	validator('json', apiDef['/api/billing/cancel-crypto-order'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/cancel-crypto-order', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const deleted = await db
			.delete(cryptoPaymentOrders)
			.where(and(
				eq(cryptoPaymentOrders.id, body.orderId),
				eq(cryptoPaymentOrders.userId, user.id),
				eq(cryptoPaymentOrders.status, 'pending'),
				isNull(cryptoPaymentOrders.txHash),
			))
			.returning({ id: cryptoPaymentOrders.id });
		if (deleted.length === 0) throw apiError(404, 'PAYMENT_ORDER_NOT_FOUND');
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/billing/cancel-crypto-order')),
);

app.post(
	'/list-my-payments',
	describeRoute(omitResAndReq(apiDef['/api/billing/list-my-payments'])),
	validator('json', apiDef['/api/billing/list-my-payments'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/list-my-payments', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const { limit, cursor } = pageParams(c.req.valid('json'));
		const rows = await db
			.select()
			.from(cryptoPaymentOrders)
			.where(cursor
				? and(eq(cryptoPaymentOrders.userId, user.id), lt(cryptoPaymentOrders.id, cursor))
				: eq(cryptoPaymentOrders.userId, user.id))
			.orderBy(desc(cryptoPaymentOrders.id))
			.limit(limit + 1);
		return c.json(idPage(rows, limit, row => row), 200);
	}, getResponseDefWithAuth('/api/billing/list-my-payments')),
);

export const billingRoutes = app;
