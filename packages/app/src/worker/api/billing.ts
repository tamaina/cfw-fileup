import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { and, desc, eq, lt } from 'drizzle-orm';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { authMiddleware } from '../middleware/auth';
import { cryptoPaymentOrders, paymentAssetDeployments, paymentAssetPlanPrices, paymentAssets, paymentChains, plans, userWallets } from '../scheme/index';
import { confirmCryptoPaymentOrder, getCryptoPaymentOrderExpiresAt } from '../utils/billing';
import { apiError } from '../utils/api-error';
import { getDb } from '../utils/db';
import { recordModerationEvent } from '../utils/moderation';
import { omitResAndReq } from '../utils/omit';
import { idPage, pageParams } from '../utils/pagination';
import { isPaymentChainRpcConfigured } from '../utils/payment-rpc';
import { genEaidx } from '../../shared/eaid-x';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

async function listEnabledOffers(env: Env) {
	const db = getDb(env);
	const rows = await db
		.select({
			id: paymentAssetPlanPrices.id,
			deploymentId: paymentAssetPlanPrices.deploymentId,
			assetId: paymentAssets.id,
			assetSymbol: paymentAssets.symbol,
			assetName: paymentAssets.name,
			chainId: paymentChains.chainId,
			chainName: paymentChains.name,
			confirmationsRequired: paymentChains.confirmationsRequired,
			contractAddress: paymentAssetDeployments.contractAddress,
			recipientAddress: paymentAssetDeployments.recipientAddress,
			decimals: paymentAssetDeployments.decimals,
			planId: plans.id,
			planName: plans.name,
			amountBaseUnits: paymentAssetPlanPrices.amountBaseUnits,
			durationDays: paymentAssetPlanPrices.durationDays,
			isEnabled: paymentAssetPlanPrices.isEnabled,
			createdAt: paymentAssetPlanPrices.createdAt,
			updatedAt: paymentAssetPlanPrices.updatedAt,
		})
		.from(paymentAssetPlanPrices)
		.innerJoin(paymentAssetDeployments, eq(paymentAssetPlanPrices.deploymentId, paymentAssetDeployments.id))
		.innerJoin(paymentAssets, eq(paymentAssetDeployments.assetId, paymentAssets.id))
		.innerJoin(paymentChains, eq(paymentAssetDeployments.chainId, paymentChains.chainId))
		.innerJoin(plans, eq(paymentAssetPlanPrices.planId, plans.id))
		.where(and(
			eq(paymentAssetPlanPrices.isEnabled, true),
			eq(paymentAssetDeployments.isEnabled, true),
			eq(paymentAssets.isEnabled, true),
			eq(paymentChains.isEnabled, true),
		))
		.orderBy(desc(paymentAssetPlanPrices.id));

	return rows.map(row => ({
		id: row.id,
		deploymentId: row.deploymentId,
		assetId: row.assetId,
		assetSymbol: row.assetSymbol,
		assetName: row.assetName,
		chainId: row.chainId,
		chainName: row.chainName,
		confirmationsRequired: row.confirmationsRequired,
		contractAddress: row.contractAddress,
		recipientAddress: row.recipientAddress,
		decimals: row.decimals,
		plan: { id: row.planId, name: row.planName },
		amountBaseUnits: row.amountBaseUnits,
		durationDays: row.durationDays,
		isEnabled: row.isEnabled,
		isRpcConfigured: isPaymentChainRpcConfigured(env, row.chainId),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}));
}

app.post(
	'/list-crypto-offers',
	describeRoute(omitResAndReq(apiDef['/api/billing/list-crypto-offers'])),
	validator('json', apiDef['/api/billing/list-crypto-offers'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/list-crypto-offers', Env>) => c.json(await listEnabledOffers(c.env), 200), getResponseDefWithAuth('/api/billing/list-crypto-offers')),
);

app.post(
	'/create-crypto-order',
	describeRoute(omitResAndReq(apiDef['/api/billing/create-crypto-order'])),
	validator('json', apiDef['/api/billing/create-crypto-order'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/create-crypto-order', Env>) => {
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
				contractAddress: paymentAssetDeployments.contractAddress,
				recipientAddress: paymentAssetDeployments.recipientAddress,
				amountBaseUnits: paymentAssetPlanPrices.amountBaseUnits,
				decimals: paymentAssetDeployments.decimals,
				durationDays: paymentAssetPlanPrices.durationDays,
			})
			.from(paymentAssetPlanPrices)
			.innerJoin(paymentAssetDeployments, eq(paymentAssetPlanPrices.deploymentId, paymentAssetDeployments.id))
			.innerJoin(paymentAssets, eq(paymentAssetDeployments.assetId, paymentAssets.id))
			.innerJoin(paymentChains, eq(paymentAssetDeployments.chainId, paymentChains.chainId))
			.innerJoin(plans, eq(paymentAssetPlanPrices.planId, plans.id))
			.where(and(
				eq(paymentAssetPlanPrices.id, body.priceId),
				eq(paymentAssetPlanPrices.isEnabled, true),
				eq(paymentAssetDeployments.isEnabled, true),
				eq(paymentAssets.isEnabled, true),
				eq(paymentChains.isEnabled, true),
			))
			.get();
		if (!price) throw apiError(404, 'PAYMENT_PRICE_NOT_FOUND');
		if (wallet.chainId !== price.chainId) throw apiError(400, 'WALLET_NOT_FOUND');

		const now = Date.now();
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
			assetSymbol: price.assetSymbol,
			assetName: price.assetName,
			contractAddress: price.contractAddress,
			recipientAddress: price.recipientAddress,
			amountBaseUnits: price.amountBaseUnits,
			decimals: price.decimals,
			durationDays: price.durationDays,
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
		const user = c.get('user');
		const body = c.req.valid('json');
		const order = await confirmCryptoPaymentOrder(c.env, user.id, body.orderId, body.txHash);
		await recordModerationEvent(c, 'crypto_payment_order_confirmed', { orderId: order.id, chainId: order.chainId, txHash: order.txHash }, user.id, user.tokenId);
		return c.json(order, 200);
	}, getResponseDefWithAuth('/api/billing/confirm-crypto-order')),
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
