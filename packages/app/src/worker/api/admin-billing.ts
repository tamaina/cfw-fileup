import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { genEaidx } from '../../shared/eaid-x';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { cryptoPaymentOrders, paymentAssetDeployments, paymentAssetPlanPrices, paymentAssets, paymentChains, plans } from '../scheme/index';
import { apiError } from '../utils/api-error';
import { getDb } from '../utils/db';
import { recordModerationAuditLog } from '../utils/moderation';
import { omitResAndReq } from '../utils/omit';
import { idPage, pageParams } from '../utils/pagination';
import { isPaymentChainRpcConfigured, normalizeEthAddress } from '../utils/payment-rpc';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);
app.use(adminMiddleware);

function mapChain(env: Env, chain: typeof paymentChains.$inferSelect) {
	return {
		...chain,
		isRpcConfigured: isPaymentChainRpcConfigured(env, chain.chainId),
	};
}

async function listDeployments(env: Env) {
	const db = getDb(env);
	const rows = await db
		.select({
			id: paymentAssetDeployments.id,
			assetId: paymentAssetDeployments.assetId,
			assetSymbol: paymentAssets.symbol,
			assetName: paymentAssets.name,
			chainId: paymentAssetDeployments.chainId,
			chainName: paymentChains.name,
			contractAddress: paymentAssetDeployments.contractAddress,
			decimals: paymentAssetDeployments.decimals,
			recipientAddress: paymentAssetDeployments.recipientAddress,
			isEnabled: paymentAssetDeployments.isEnabled,
			createdAt: paymentAssetDeployments.createdAt,
			updatedAt: paymentAssetDeployments.updatedAt,
		})
		.from(paymentAssetDeployments)
		.innerJoin(paymentAssets, eq(paymentAssetDeployments.assetId, paymentAssets.id))
		.innerJoin(paymentChains, eq(paymentAssetDeployments.chainId, paymentChains.chainId))
		.orderBy(desc(paymentAssetDeployments.id));

	return rows.map(row => ({
		...row,
		isRpcConfigured: isPaymentChainRpcConfigured(env, row.chainId),
	}));
}

async function getDeploymentResponse(env: Env, deploymentId: string) {
	return (await listDeployments(env)).find(deployment => deployment.id === deploymentId) ?? null;
}

async function listPrices(env: Env) {
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
		.orderBy(desc(paymentAssetPlanPrices.id));

	return rows.map(row => ({
		id: row.id,
		deploymentId: row.deploymentId,
		assetId: row.assetId,
		assetSymbol: row.assetSymbol,
		assetName: row.assetName,
		chainId: row.chainId,
		chainName: row.chainName,
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

async function getPriceResponse(env: Env, priceId: string) {
	return (await listPrices(env)).find(price => price.id === priceId) ?? null;
}

app.post(
	'/list-payment-chains',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-payment-chains'])),
	validator('json', apiDef['/api/admin/list-payment-chains'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-payment-chains', Env>) => {
		const db = getDb(c.env);
		const chains = await db.select().from(paymentChains).orderBy(desc(paymentChains.chainId));
		return c.json(chains.map(chain => mapChain(c.env, chain)), 200);
	}, getResponseDefWithAuth('/api/admin/list-payment-chains')),
);

app.post(
	'/create-payment-chain',
	describeRoute(omitResAndReq(apiDef['/api/admin/create-payment-chain'])),
	validator('json', apiDef['/api/admin/create-payment-chain'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/create-payment-chain', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const now = Date.now();
		const chain = { ...body, createdAt: now, updatedAt: now };
		await db.insert(paymentChains).values(chain);
		await recordModerationAuditLog(c, 'admin_payment_chain_created', { data: { chainId: chain.chainId } });
		return c.json(mapChain(c.env, chain), 200);
	}, getResponseDefWithAuth('/api/admin/create-payment-chain')),
);

app.post(
	'/update-payment-chain',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-payment-chain'])),
	validator('json', apiDef['/api/admin/update-payment-chain'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-payment-chain', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select().from(paymentChains).where(eq(paymentChains.chainId, body.chainId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_CHAIN_NOT_FOUND');
		const updated = { ...existing, ...body, updatedAt: Date.now() };
		await db.update(paymentChains).set(updated).where(eq(paymentChains.chainId, body.chainId));
		await recordModerationAuditLog(c, 'admin_payment_chain_updated', { data: { chainId: body.chainId } });
		return c.json(mapChain(c.env, updated), 200);
	}, getResponseDefWithAuth('/api/admin/update-payment-chain')),
);

app.post(
	'/delete-payment-chain',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-payment-chain'])),
	validator('json', apiDef['/api/admin/delete-payment-chain'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-payment-chain', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select({ chainId: paymentChains.chainId }).from(paymentChains).where(eq(paymentChains.chainId, body.chainId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_CHAIN_NOT_FOUND');
		await db.delete(paymentChains).where(eq(paymentChains.chainId, body.chainId));
		await recordModerationAuditLog(c, 'admin_payment_chain_deleted', { data: { chainId: body.chainId } });
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-payment-chain')),
);

app.post(
	'/list-payment-assets',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-payment-assets'])),
	validator('json', apiDef['/api/admin/list-payment-assets'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-payment-assets', Env>) => {
		const db = getDb(c.env);
		return c.json(await db.select().from(paymentAssets).orderBy(desc(paymentAssets.id)), 200);
	}, getResponseDefWithAuth('/api/admin/list-payment-assets')),
);

app.post(
	'/create-payment-asset',
	describeRoute(omitResAndReq(apiDef['/api/admin/create-payment-asset'])),
	validator('json', apiDef['/api/admin/create-payment-asset'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/create-payment-asset', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const now = Date.now();
		const asset = { id: genEaidx(now), symbol: body.symbol, name: body.name, isEnabled: body.isEnabled, createdAt: now, updatedAt: now };
		await db.insert(paymentAssets).values(asset);
		await recordModerationAuditLog(c, 'admin_payment_asset_created', { data: { assetId: asset.id, symbol: asset.symbol } });
		return c.json(asset, 200);
	}, getResponseDefWithAuth('/api/admin/create-payment-asset')),
);

app.post(
	'/update-payment-asset',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-payment-asset'])),
	validator('json', apiDef['/api/admin/update-payment-asset'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-payment-asset', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select().from(paymentAssets).where(eq(paymentAssets.id, body.assetId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_ASSET_NOT_FOUND');
		const updated = { ...existing, symbol: body.symbol, name: body.name, isEnabled: body.isEnabled, updatedAt: Date.now() };
		await db.update(paymentAssets).set(updated).where(eq(paymentAssets.id, body.assetId));
		await recordModerationAuditLog(c, 'admin_payment_asset_updated', { data: { assetId: body.assetId, symbol: updated.symbol } });
		return c.json(updated, 200);
	}, getResponseDefWithAuth('/api/admin/update-payment-asset')),
);

app.post(
	'/delete-payment-asset',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-payment-asset'])),
	validator('json', apiDef['/api/admin/delete-payment-asset'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-payment-asset', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select({ id: paymentAssets.id }).from(paymentAssets).where(eq(paymentAssets.id, body.assetId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_ASSET_NOT_FOUND');
		await db.delete(paymentAssets).where(eq(paymentAssets.id, body.assetId));
		await recordModerationAuditLog(c, 'admin_payment_asset_deleted', { data: { assetId: body.assetId } });
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-payment-asset')),
);

app.post(
	'/list-payment-asset-deployments',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-payment-asset-deployments'])),
	validator('json', apiDef['/api/admin/list-payment-asset-deployments'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-payment-asset-deployments', Env>) => c.json(await listDeployments(c.env), 200), getResponseDefWithAuth('/api/admin/list-payment-asset-deployments')),
);

app.post(
	'/create-payment-asset-deployment',
	describeRoute(omitResAndReq(apiDef['/api/admin/create-payment-asset-deployment'])),
	validator('json', apiDef['/api/admin/create-payment-asset-deployment'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/create-payment-asset-deployment', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const [asset, chain] = await Promise.all([
			db.select({ id: paymentAssets.id }).from(paymentAssets).where(eq(paymentAssets.id, body.assetId)).get(),
			db.select({ chainId: paymentChains.chainId }).from(paymentChains).where(eq(paymentChains.chainId, body.chainId)).get(),
		]);
		if (!asset) throw apiError(404, 'PAYMENT_ASSET_NOT_FOUND');
		if (!chain) throw apiError(404, 'PAYMENT_CHAIN_NOT_FOUND');
		const contractAddress = normalizeEthAddress(body.contractAddress);
		const existingDeployment = await db
			.select({ id: paymentAssetDeployments.id })
			.from(paymentAssetDeployments)
			.where(and(eq(paymentAssetDeployments.chainId, body.chainId), eq(paymentAssetDeployments.contractAddress, contractAddress)))
			.get();
		if (existingDeployment) throw apiError(400, 'PAYMENT_ASSET_DEPLOYMENT_ALREADY_EXISTS');
		const now = Date.now();
		const deployment = {
			id: genEaidx(now),
			assetId: body.assetId,
			chainId: body.chainId,
			contractAddress,
			decimals: body.decimals,
			recipientAddress: normalizeEthAddress(body.recipientAddress),
			isEnabled: body.isEnabled,
			createdAt: now,
			updatedAt: now,
		};
		await db.insert(paymentAssetDeployments).values(deployment);
		await recordModerationAuditLog(c, 'admin_payment_deployment_created', { data: { deploymentId: deployment.id } });
		const response = await getDeploymentResponse(c.env, deployment.id);
		if (!response) throw apiError(404, 'PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND');
		return c.json(response, 200);
	}, getResponseDefWithAuth('/api/admin/create-payment-asset-deployment')),
);

app.post(
	'/update-payment-asset-deployment',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-payment-asset-deployment'])),
	validator('json', apiDef['/api/admin/update-payment-asset-deployment'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-payment-asset-deployment', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select().from(paymentAssetDeployments).where(eq(paymentAssetDeployments.id, body.deploymentId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND');
		const [asset, chain] = await Promise.all([
			db.select({ id: paymentAssets.id }).from(paymentAssets).where(eq(paymentAssets.id, body.assetId)).get(),
			db.select({ chainId: paymentChains.chainId }).from(paymentChains).where(eq(paymentChains.chainId, body.chainId)).get(),
		]);
		if (!asset) throw apiError(404, 'PAYMENT_ASSET_NOT_FOUND');
		if (!chain) throw apiError(404, 'PAYMENT_CHAIN_NOT_FOUND');
		const contractAddress = normalizeEthAddress(body.contractAddress);
		const conflict = await db
			.select({ id: paymentAssetDeployments.id })
			.from(paymentAssetDeployments)
			.where(and(
				eq(paymentAssetDeployments.chainId, body.chainId),
				eq(paymentAssetDeployments.contractAddress, contractAddress),
				ne(paymentAssetDeployments.id, body.deploymentId),
			))
			.get();
		if (conflict) throw apiError(400, 'PAYMENT_ASSET_DEPLOYMENT_ALREADY_EXISTS');
		const updated = {
			...existing,
			assetId: body.assetId,
			chainId: body.chainId,
			contractAddress,
			decimals: body.decimals,
			recipientAddress: normalizeEthAddress(body.recipientAddress),
			isEnabled: body.isEnabled,
			updatedAt: Date.now(),
		};
		await db.update(paymentAssetDeployments).set(updated).where(eq(paymentAssetDeployments.id, body.deploymentId));
		await recordModerationAuditLog(c, 'admin_payment_deployment_updated', { data: { deploymentId: body.deploymentId } });
		const response = await getDeploymentResponse(c.env, body.deploymentId);
		if (!response) throw apiError(404, 'PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND');
		return c.json(response, 200);
	}, getResponseDefWithAuth('/api/admin/update-payment-asset-deployment')),
);

app.post(
	'/delete-payment-asset-deployment',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-payment-asset-deployment'])),
	validator('json', apiDef['/api/admin/delete-payment-asset-deployment'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-payment-asset-deployment', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select({ id: paymentAssetDeployments.id }).from(paymentAssetDeployments).where(eq(paymentAssetDeployments.id, body.deploymentId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND');
		await db.delete(paymentAssetDeployments).where(eq(paymentAssetDeployments.id, body.deploymentId));
		await recordModerationAuditLog(c, 'admin_payment_deployment_deleted', { data: { deploymentId: body.deploymentId } });
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-payment-asset-deployment')),
);

app.post(
	'/list-payment-asset-plan-prices',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-payment-asset-plan-prices'])),
	validator('json', apiDef['/api/admin/list-payment-asset-plan-prices'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-payment-asset-plan-prices', Env>) => c.json(await listPrices(c.env), 200), getResponseDefWithAuth('/api/admin/list-payment-asset-plan-prices')),
);

app.post(
	'/create-payment-asset-plan-price',
	describeRoute(omitResAndReq(apiDef['/api/admin/create-payment-asset-plan-price'])),
	validator('json', apiDef['/api/admin/create-payment-asset-plan-price'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/create-payment-asset-plan-price', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const [deployment, plan] = await Promise.all([
			db.select({ id: paymentAssetDeployments.id }).from(paymentAssetDeployments).where(eq(paymentAssetDeployments.id, body.deploymentId)).get(),
			db.select({ id: plans.id }).from(plans).where(eq(plans.id, body.planId)).get(),
		]);
		if (!deployment) throw apiError(404, 'PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND');
		if (!plan) throw apiError(404, 'PLAN_NOT_FOUND');
		const now = Date.now();
		const price = { id: genEaidx(now), deploymentId: body.deploymentId, planId: body.planId, amountBaseUnits: body.amountBaseUnits, durationDays: body.durationDays, isEnabled: body.isEnabled, createdAt: now, updatedAt: now };
		await db.insert(paymentAssetPlanPrices).values(price);
		await recordModerationAuditLog(c, 'admin_payment_price_created', { data: { priceId: price.id } });
		const response = await getPriceResponse(c.env, price.id);
		if (!response) throw apiError(404, 'PAYMENT_PRICE_NOT_FOUND');
		return c.json(response, 200);
	}, getResponseDefWithAuth('/api/admin/create-payment-asset-plan-price')),
);

app.post(
	'/update-payment-asset-plan-price',
	describeRoute(omitResAndReq(apiDef['/api/admin/update-payment-asset-plan-price'])),
	validator('json', apiDef['/api/admin/update-payment-asset-plan-price'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/update-payment-asset-plan-price', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select().from(paymentAssetPlanPrices).where(eq(paymentAssetPlanPrices.id, body.priceId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_PRICE_NOT_FOUND');
		const [deployment, plan] = await Promise.all([
			db.select({ id: paymentAssetDeployments.id }).from(paymentAssetDeployments).where(eq(paymentAssetDeployments.id, body.deploymentId)).get(),
			db.select({ id: plans.id }).from(plans).where(eq(plans.id, body.planId)).get(),
		]);
		if (!deployment) throw apiError(404, 'PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND');
		if (!plan) throw apiError(404, 'PLAN_NOT_FOUND');
		const updated = { ...existing, deploymentId: body.deploymentId, planId: body.planId, amountBaseUnits: body.amountBaseUnits, durationDays: body.durationDays, isEnabled: body.isEnabled, updatedAt: Date.now() };
		await db.update(paymentAssetPlanPrices).set(updated).where(eq(paymentAssetPlanPrices.id, body.priceId));
		await recordModerationAuditLog(c, 'admin_payment_price_updated', { data: { priceId: body.priceId } });
		const response = await getPriceResponse(c.env, body.priceId);
		if (!response) throw apiError(404, 'PAYMENT_PRICE_NOT_FOUND');
		return c.json(response, 200);
	}, getResponseDefWithAuth('/api/admin/update-payment-asset-plan-price')),
);

app.post(
	'/delete-payment-asset-plan-price',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-payment-asset-plan-price'])),
	validator('json', apiDef['/api/admin/delete-payment-asset-plan-price'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-payment-asset-plan-price', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select({ id: paymentAssetPlanPrices.id }).from(paymentAssetPlanPrices).where(eq(paymentAssetPlanPrices.id, body.priceId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_PRICE_NOT_FOUND');
		await db.delete(paymentAssetPlanPrices).where(eq(paymentAssetPlanPrices.id, body.priceId));
		await recordModerationAuditLog(c, 'admin_payment_price_deleted', { data: { priceId: body.priceId } });
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-payment-asset-plan-price')),
);

app.post(
	'/list-crypto-payment-orders',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-crypto-payment-orders'])),
	validator('json', apiDef['/api/admin/list-crypto-payment-orders'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-crypto-payment-orders', Env>) => {
		const db = getDb(c.env);
		const { limit, cursor } = pageParams(c.req.valid('json'));
		const rows = await db
			.select()
			.from(cryptoPaymentOrders)
			.where(cursor ? lt(cryptoPaymentOrders.id, cursor) : undefined)
			.orderBy(desc(cryptoPaymentOrders.id))
			.limit(limit + 1);
		return c.json(idPage(rows, limit, row => row), 200);
	}, getResponseDefWithAuth('/api/admin/list-crypto-payment-orders')),
);

export const adminBillingRoutes = app;
