import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { createPublicClient, http, parseAbi } from 'viem';
import { genEaidx } from '../../shared/eaid-x';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { evaluateDealDisplayEligibility, getPriceDisplayWindow, type PaymentDurationUnit, type PriceHistoryPeriod } from '../../shared/billing-quote';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { cryptoPaymentOrders, paymentAssetDeployments, paymentAssetPlanPrices, paymentAssets, paymentChains, plans } from '../scheme/index';
import { ApiError, apiError } from '../utils/api-error';
import { checkAnyCryptoPaymentOrderWithPreviousStatus, listCryptoPaymentOrders } from '../utils/billing';
import { getContextWaitUntil } from '../utils/background-task';
import { getDb } from '../utils/db';
import { recordModerationAuditLog } from '../utils/moderation';
import { omitResAndReq } from '../utils/omit';
import { idPage, pageParams } from '../utils/pagination';
import { getPaymentChainRpcUrl, isPaymentChainRpcConfigured, normalizeEthAddress } from '../utils/payment-rpc';

const app = new Hono<{ Bindings: Env }>();
const ERC20_METADATA_ABI = parseAbi([
	'function symbol() view returns (string)',
	'function name() view returns (string)',
	'function decimals() view returns (uint8)',
]);

type PaymentPriceRuleInput = {
	id?: string;
	assetId: string;
	planId: string;
	amountBaseUnits: string;
	durationDays: number;
	durationUnit: PaymentDurationUnit;
	startsAt: number;
	expiresAt: number | null;
};

app.use(authMiddleware);
app.use(adminMiddleware);

function mapChain(env: Env, chain: typeof paymentChains.$inferSelect) {
	return {
		...chain,
		isRpcConfigured: isPaymentChainRpcConfigured(env, chain.chainId),
	};
}

async function listDeployments(env: Env, deploymentId?: string) {
	const db = getDb(env);
	const rows = await db
		.select({
			id: paymentAssetDeployments.id,
			assetId: paymentAssetDeployments.assetId,
			assetSymbol: paymentAssets.symbol,
			assetName: paymentAssets.name,
			chainId: paymentAssetDeployments.chainId,
			chainName: paymentChains.name,
			tokenSymbol: paymentAssetDeployments.tokenSymbol,
			tokenName: paymentAssetDeployments.tokenName,
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
		.where(deploymentId ? eq(paymentAssetDeployments.id, deploymentId) : undefined)
		.orderBy(desc(paymentAssetDeployments.id));

	return rows.map(row => ({
		...row,
		isRpcConfigured: isPaymentChainRpcConfigured(env, row.chainId),
	}));
}

async function getDeploymentResponse(env: Env, deploymentId: string) {
	return (await listDeployments(env, deploymentId))[0] ?? null;
}

async function listPrices(env: Env, priceId?: string) {
	const db = getDb(env);
	const now = Date.now();
	const rows = await db
		.select({
			id: paymentAssetPlanPrices.id,
			assetId: paymentAssets.id,
			assetSymbol: paymentAssets.symbol,
			assetName: paymentAssets.name,
			planId: plans.id,
			planName: plans.name,
			planMaxBuckets: plans.maxBuckets,
			planMaxBucketSizeBytes: plans.maxBucketSizeBytes,
			planMaxFilesPerBucket: plans.maxFilesPerBucket,
			planMaxDailyUploads: plans.maxDailyUploads,
			planCanUseDownloadCount: plans.canUseDownloadCount,
			planShowAds: plans.showAds,
			planCanDisableFileAds: plans.canDisableFileAds,
			planSortOrder: plans.sortOrder,
			amountBaseUnits: paymentAssetPlanPrices.amountBaseUnits,
			durationDays: paymentAssetPlanPrices.durationDays,
			durationUnit: paymentAssetPlanPrices.durationUnit,
			startsAt: paymentAssetPlanPrices.startsAt,
			expiresAt: paymentAssetPlanPrices.expiresAt,
			createdAt: paymentAssetPlanPrices.createdAt,
			updatedAt: paymentAssetPlanPrices.updatedAt,
		})
		.from(paymentAssetPlanPrices)
		.innerJoin(paymentAssets, eq(paymentAssetPlanPrices.assetId, paymentAssets.id))
		.innerJoin(plans, eq(paymentAssetPlanPrices.planId, plans.id))
		.where(priceId ? eq(paymentAssetPlanPrices.id, priceId) : undefined)
		.orderBy(desc(paymentAssetPlanPrices.id));
	const periods = await listPriceHistoryPeriods(env);

	return rows.map(row => {
		const pricePeriods = periods.filter(period => (
			period.assetId === row.assetId
			&& period.planId === row.planId
			&& period.durationDays === row.durationDays
			&& period.durationUnit === row.durationUnit
		));
		const fallbackPeriod: PriceHistoryPeriod = {
			id: row.id,
			priceId: row.id,
			assetId: row.assetId,
			planId: row.planId,
			amountBaseUnits: row.amountBaseUnits,
			durationDays: row.durationDays,
			durationUnit: row.durationUnit,
			isEnabled: row.startsAt <= now && (row.expiresAt == null || row.expiresAt > now),
			startsAt: row.startsAt,
			expiresAt: row.expiresAt,
		};
		const history = pricePeriods.length > 0 ? pricePeriods : [fallbackPeriod];
		const dealDisplay = evaluateDealDisplayEligibility(history, {
			assetId: row.assetId,
			planId: row.planId,
			amountBaseUnits: row.amountBaseUnits,
			durationDays: row.durationDays,
			durationUnit: row.durationUnit,
		}, now);
		return {
			id: row.id,
			deploymentId: null,
			assetId: row.assetId,
			assetSymbol: row.assetSymbol,
			assetName: row.assetName,
			tokenSymbol: null,
			tokenName: null,
			chainId: null,
			chainName: null,
			confirmationsRequired: null,
			contractAddress: null,
			recipientAddress: null,
			decimals: null,
			plan: {
				id: row.planId,
				name: row.planName,
				maxBuckets: row.planMaxBuckets,
				maxBucketSizeBytes: row.planMaxBucketSizeBytes,
				maxFilesPerBucket: row.planMaxFilesPerBucket,
				maxDailyUploads: row.planMaxDailyUploads,
				canUseDownloadCount: row.planCanUseDownloadCount,
				showAds: row.planShowAds,
				canDisableFileAds: row.planCanDisableFileAds,
				sortOrder: row.planSortOrder,
			},
			amountBaseUnits: row.amountBaseUnits,
			durationDays: row.durationDays,
			durationUnit: row.durationUnit,
			isEnabled: row.startsAt <= now && (row.expiresAt == null || row.expiresAt > now),
			startsAt: row.startsAt,
			expiresAt: row.expiresAt,
			isRpcConfigured: false,
			quote: {
				quoteCreatedAt: row.updatedAt,
				quoteExpiresAt: row.updatedAt,
				baseAmountBaseUnits: row.amountBaseUnits,
				discountBaseUnits: '0',
				payableAmountBaseUnits: row.amountBaseUnits,
				effectiveStartsAt: row.updatedAt,
				effectiveExpiresAt: row.updatedAt,
				currentPlan: null,
			},
			dealDisplay,
			priceHistory: history,
			priceDisplayWindow: getPriceDisplayWindow(history, row.id, now),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	});
}

async function getPriceResponse(env: Env, priceId: string) {
	return (await listPrices(env, priceId))[0] ?? null;
}

async function listPriceHistoryPeriods(env: Env): Promise<PriceHistoryPeriod[]> {
	return (await getDb(env)
		.select({
			id: paymentAssetPlanPrices.id,
			assetId: paymentAssetPlanPrices.assetId,
			planId: paymentAssetPlanPrices.planId,
			amountBaseUnits: paymentAssetPlanPrices.amountBaseUnits,
			durationDays: paymentAssetPlanPrices.durationDays,
			durationUnit: paymentAssetPlanPrices.durationUnit,
			startsAt: paymentAssetPlanPrices.startsAt,
			expiresAt: paymentAssetPlanPrices.expiresAt,
		})
		.from(paymentAssetPlanPrices)
		.orderBy(
			asc(paymentAssetPlanPrices.assetId),
			asc(paymentAssetPlanPrices.planId),
			asc(paymentAssetPlanPrices.durationDays),
			asc(paymentAssetPlanPrices.durationUnit),
			asc(paymentAssetPlanPrices.startsAt),
			asc(paymentAssetPlanPrices.id),
		)).map(period => ({
		id: period.id,
		priceId: period.id,
		assetId: period.assetId,
		planId: period.planId,
		amountBaseUnits: period.amountBaseUnits,
		durationDays: period.durationDays,
		durationUnit: period.durationUnit,
		isEnabled: period.startsAt <= Date.now() && (period.expiresAt == null || period.expiresAt > Date.now()),
		startsAt: period.startsAt,
		expiresAt: period.expiresAt,
	}));
}

function durationSortValue(value: number, unit: PaymentDurationUnit): number {
	const date = new Date(Date.UTC(2024, 0, 1));
	if (unit === 'days') date.setUTCDate(date.getUTCDate() + value);
	if (unit === 'months') date.setUTCMonth(date.getUTCMonth() + value);
	if (unit === 'years') date.setUTCFullYear(date.getUTCFullYear() + value);
	return date.getTime();
}

async function assertPaymentPriceRules(env: Env, input: PaymentPriceRuleInput): Promise<void> {
	const db = getDb(env);
	if (input.expiresAt != null && input.expiresAt <= input.startsAt) throw apiError(400, 'PAYMENT_PRICE_ORDER_INVALID');
	const existingPrices = await db
		.select({
			id: paymentAssetPlanPrices.id,
			amountBaseUnits: paymentAssetPlanPrices.amountBaseUnits,
			durationDays: paymentAssetPlanPrices.durationDays,
			durationUnit: paymentAssetPlanPrices.durationUnit,
			startsAt: paymentAssetPlanPrices.startsAt,
			expiresAt: paymentAssetPlanPrices.expiresAt,
		})
		.from(paymentAssetPlanPrices)
		.where(and(
			eq(paymentAssetPlanPrices.assetId, input.assetId),
			eq(paymentAssetPlanPrices.planId, input.planId),
		));

	const inputDuration = durationSortValue(input.durationDays, input.durationUnit);
	const inputAmount = BigInt(input.amountBaseUnits);
	const inputEnd = input.expiresAt ?? Number.MAX_SAFE_INTEGER;
	for (const price of existingPrices) {
		const existingEnd = price.expiresAt ?? Number.MAX_SAFE_INTEGER;
		const periodsOverlap = input.startsAt < existingEnd && inputEnd > price.startsAt;
		if (!periodsOverlap) continue;
		if (input.durationDays === price.durationDays && input.durationUnit === price.durationUnit) {
			throw apiError(400, 'PAYMENT_PRICE_ALREADY_EXISTS');
		}
		const existingDuration = durationSortValue(price.durationDays, price.durationUnit);
		const existingAmount = BigInt(price.amountBaseUnits);
		if (inputDuration > existingDuration && inputAmount < existingAmount) {
			throw apiError(400, 'PAYMENT_PRICE_ORDER_INVALID');
		}
		if (inputDuration < existingDuration && inputAmount > existingAmount) {
			throw apiError(400, 'PAYMENT_PRICE_ORDER_INVALID');
		}
	}
}

function chainAuditData(chain: typeof paymentChains.$inferSelect): Record<string, unknown> {
	return {
		chainId: chain.chainId,
		chainName: chain.name,
		nativeCurrencyName: chain.nativeCurrencyName,
		nativeCurrencySymbol: chain.nativeCurrencySymbol,
		nativeCurrencyDecimals: chain.nativeCurrencyDecimals,
		blockExplorerUrl: chain.blockExplorerUrl,
		confirmationsRequired: chain.confirmationsRequired,
		isEnabled: chain.isEnabled,
	};
}

function assetAuditData(asset: typeof paymentAssets.$inferSelect): Record<string, unknown> {
	return {
		assetId: asset.id,
		assetSymbol: asset.symbol,
		assetName: asset.name,
		currencyCode: asset.currencyCode,
		isEnabled: asset.isEnabled,
	};
}

function deploymentAuditData(deployment: NonNullable<Awaited<ReturnType<typeof getDeploymentResponse>>>): Record<string, unknown> {
	return {
		deploymentId: deployment.id,
		assetId: deployment.assetId,
		assetSymbol: deployment.assetSymbol,
		assetName: deployment.assetName,
		tokenSymbol: deployment.tokenSymbol,
		tokenName: deployment.tokenName,
		chainId: deployment.chainId,
		chainName: deployment.chainName,
		contractAddress: deployment.contractAddress,
		decimals: deployment.decimals,
		recipientAddress: deployment.recipientAddress,
		isEnabled: deployment.isEnabled,
		isRpcConfigured: deployment.isRpcConfigured,
	};
}

function priceAuditData(price: NonNullable<Awaited<ReturnType<typeof getPriceResponse>>>): Record<string, unknown> {
	return {
		priceId: price.id,
		planId: price.plan.id,
		planName: price.plan.name,
		assetId: price.assetId,
		assetSymbol: price.assetSymbol,
		assetName: price.assetName,
		amountBaseUnits: price.amountBaseUnits,
		durationDays: price.durationDays,
		durationUnit: price.durationUnit,
		startsAt: price.startsAt,
		expiresAt: price.expiresAt,
	};
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
		await recordModerationAuditLog(c, 'admin_payment_chain_created', { data: chainAuditData(chain) });
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
		await recordModerationAuditLog(c, 'admin_payment_chain_updated', { data: chainAuditData(updated) });
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
		const existing = await db.select().from(paymentChains).where(eq(paymentChains.chainId, body.chainId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_CHAIN_NOT_FOUND');
		await db.delete(paymentChains).where(eq(paymentChains.chainId, body.chainId));
		await recordModerationAuditLog(c, 'admin_payment_chain_deleted', { data: chainAuditData(existing) });
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-payment-chain')),
);

app.post(
	'/test-payment-chain-rpc',
	describeRoute(omitResAndReq(apiDef['/api/admin/test-payment-chain-rpc'])),
	validator('json', apiDef['/api/admin/test-payment-chain-rpc'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/test-payment-chain-rpc', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const chain = await db.select({ chainId: paymentChains.chainId }).from(paymentChains).where(eq(paymentChains.chainId, body.chainId)).get();
		if (!chain) throw apiError(404, 'PAYMENT_CHAIN_NOT_FOUND');
		const rpcUrl = getPaymentChainRpcUrl(c.env, body.chainId);
		if (!rpcUrl) throw apiError(400, 'PAYMENT_CHAIN_RPC_NOT_CONFIGURED');

		try {
			const client = createPublicClient({ transport: http(rpcUrl) });
			const actualChainId = await client.getChainId();
			if (actualChainId !== body.chainId) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
			return c.json({ ok: true as const, chainId: actualChainId }, 200);
		} catch (e) {
			if (e instanceof ApiError) throw e;
			throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		}
	}, getResponseDefWithAuth('/api/admin/test-payment-chain-rpc')),
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
		const asset = { id: genEaidx(now), symbol: body.symbol, name: body.name, currencyCode: body.currencyCode, isEnabled: body.isEnabled, createdAt: now, updatedAt: now };
		await db.insert(paymentAssets).values(asset);
		await recordModerationAuditLog(c, 'admin_payment_asset_created', { data: assetAuditData(asset) });
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
		const updated = { ...existing, symbol: body.symbol, name: body.name, currencyCode: body.currencyCode, isEnabled: body.isEnabled, updatedAt: Date.now() };
		await db.update(paymentAssets).set(updated).where(eq(paymentAssets.id, body.assetId));
		await recordModerationAuditLog(c, 'admin_payment_asset_updated', { data: assetAuditData(updated) });
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
		const existing = await db.select().from(paymentAssets).where(eq(paymentAssets.id, body.assetId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_ASSET_NOT_FOUND');
		await db.delete(paymentAssets).where(eq(paymentAssets.id, body.assetId));
		await recordModerationAuditLog(c, 'admin_payment_asset_deleted', { data: assetAuditData(existing) });
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
	'/resolve-payment-asset-deployment',
	describeRoute(omitResAndReq(apiDef['/api/admin/resolve-payment-asset-deployment'])),
	validator('json', apiDef['/api/admin/resolve-payment-asset-deployment'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/resolve-payment-asset-deployment', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const chain = await db.select({ chainId: paymentChains.chainId }).from(paymentChains).where(eq(paymentChains.chainId, body.chainId)).get();
		if (!chain) throw apiError(404, 'PAYMENT_CHAIN_NOT_FOUND');
		const rpcUrl = getPaymentChainRpcUrl(c.env, body.chainId);
		if (!rpcUrl) throw apiError(400, 'PAYMENT_CHAIN_RPC_NOT_CONFIGURED');

		const contractAddress = normalizeEthAddress(body.contractAddress);
		const client = createPublicClient({ transport: http(rpcUrl) });
		try {
			const [symbolResult, nameResult, decimalsResult] = await Promise.allSettled([
				client.readContract({ address: contractAddress, abi: ERC20_METADATA_ABI, functionName: 'symbol' }),
				client.readContract({ address: contractAddress, abi: ERC20_METADATA_ABI, functionName: 'name' }),
				client.readContract({ address: contractAddress, abi: ERC20_METADATA_ABI, functionName: 'decimals' }),
			]);
			if (decimalsResult.status !== 'fulfilled') throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
			const decimals = Number(decimalsResult.value);
			if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');

			return c.json({
				symbol: symbolResult.status === 'fulfilled' ? symbolResult.value : null,
				name: nameResult.status === 'fulfilled' ? nameResult.value : null,
				decimals,
			}, 200);
		} catch (e) {
			if (e instanceof ApiError) throw e;
			throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
		}
	}, getResponseDefWithAuth('/api/admin/resolve-payment-asset-deployment')),
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
			tokenSymbol: body.tokenSymbol,
			tokenName: body.tokenName,
			contractAddress,
			decimals: body.decimals,
			recipientAddress: normalizeEthAddress(body.recipientAddress),
			isEnabled: body.isEnabled,
			createdAt: now,
			updatedAt: now,
		};
		await db.insert(paymentAssetDeployments).values(deployment);
		const response = await getDeploymentResponse(c.env, deployment.id);
		await recordModerationAuditLog(c, 'admin_payment_deployment_created', { data: deploymentAuditData(response) });
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
			tokenSymbol: body.tokenSymbol,
			tokenName: body.tokenName,
			contractAddress,
			decimals: body.decimals,
			recipientAddress: normalizeEthAddress(body.recipientAddress),
			isEnabled: body.isEnabled,
			updatedAt: Date.now(),
		};
		await db.update(paymentAssetDeployments).set(updated).where(eq(paymentAssetDeployments.id, body.deploymentId));
		const response = await getDeploymentResponse(c.env, body.deploymentId);
		await recordModerationAuditLog(c, 'admin_payment_deployment_updated', { data: deploymentAuditData(response) });
		return c.json(response, 200);
	}, getResponseDefWithAuth('/api/admin/update-payment-asset-deployment')),
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
		const [asset, plan] = await Promise.all([
			db.select({ id: paymentAssets.id }).from(paymentAssets).where(eq(paymentAssets.id, body.assetId)).get(),
			db.select({ id: plans.id }).from(plans).where(eq(plans.id, body.planId)).get(),
		]);
		if (!asset) throw apiError(404, 'PAYMENT_ASSET_NOT_FOUND');
		if (!plan) throw apiError(404, 'PLAN_NOT_FOUND');
		const now = Date.now();
		const startsAt = body.startsAt ?? now;
		await assertPaymentPriceRules(c.env, { ...body, startsAt });
		const price = { id: genEaidx(now), assetId: body.assetId, planId: body.planId, amountBaseUnits: body.amountBaseUnits, durationDays: body.durationDays, durationUnit: body.durationUnit, startsAt, expiresAt: body.expiresAt, createdAt: now, updatedAt: now };
		try {
			await db.insert(paymentAssetPlanPrices).values(price);
		} catch (e) {
			if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) throw apiError(400, 'PAYMENT_PRICE_ALREADY_EXISTS');
			throw e;
		}
		const response = await getPriceResponse(c.env, price.id);
		await recordModerationAuditLog(c, 'admin_payment_price_created', { data: priceAuditData(response) });
		return c.json(response, 200);
	}, getResponseDefWithAuth('/api/admin/create-payment-asset-plan-price')),
);

app.post(
	'/expire-payment-asset-plan-price',
	describeRoute(omitResAndReq(apiDef['/api/admin/expire-payment-asset-plan-price'])),
	validator('json', apiDef['/api/admin/expire-payment-asset-plan-price'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/expire-payment-asset-plan-price', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await db.select().from(paymentAssetPlanPrices).where(eq(paymentAssetPlanPrices.id, body.priceId)).get();
		if (!existing) throw apiError(404, 'PAYMENT_PRICE_NOT_FOUND');
		const now = Date.now();
		const expiresAt = body.expiresAt ?? now;
		if (expiresAt <= existing.startsAt) throw apiError(400, 'PAYMENT_PRICE_ORDER_INVALID');
		await db.update(paymentAssetPlanPrices).set({ expiresAt, updatedAt: now }).where(eq(paymentAssetPlanPrices.id, body.priceId));
		const response = await getPriceResponse(c.env, body.priceId);
		await recordModerationAuditLog(c, 'admin_payment_price_updated', { data: priceAuditData(response) });
		return c.json(response, 200);
	}, getResponseDefWithAuth('/api/admin/expire-payment-asset-plan-price')),
);

app.post(
	'/delete-payment-asset-plan-price',
	describeRoute(omitResAndReq(apiDef['/api/admin/delete-payment-asset-plan-price'])),
	validator('json', apiDef['/api/admin/delete-payment-asset-plan-price'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/delete-payment-asset-plan-price', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const existing = await getPriceResponse(c.env, body.priceId);
		await db.delete(paymentAssetPlanPrices).where(eq(paymentAssetPlanPrices.id, body.priceId));
		await recordModerationAuditLog(c, 'admin_payment_price_deleted', { data: priceAuditData(existing) });
		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/admin/delete-payment-asset-plan-price')),
);

app.post(
	'/list-crypto-payment-orders',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-crypto-payment-orders'])),
	validator('json', apiDef['/api/admin/list-crypto-payment-orders'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-crypto-payment-orders', Env>) => {
		const body = c.req.valid('json');
		const { limit, cursor } = pageParams(body);
		const rows = await listCryptoPaymentOrders(c.env, { userId: body.userId, cursor, limit: limit + 1 });
		return c.json(idPage(rows, limit, row => row), 200);
	}, getResponseDefWithAuth('/api/admin/list-crypto-payment-orders')),
);

app.post(
	'/check-crypto-payment-order',
	describeRoute(omitResAndReq(apiDef['/api/admin/check-crypto-payment-order'])),
	validator('json', apiDef['/api/admin/check-crypto-payment-order'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/check-crypto-payment-order', Env>) => {
		const body = c.req.valid('json');
		const { before, order } = await checkAnyCryptoPaymentOrderWithPreviousStatus(c.env, body.orderId, getContextWaitUntil(c));
		if (before.status !== 'paid' && order.status === 'paid') {
			await recordModerationAuditLog(c, 'admin_crypto_payment_order_confirmed', {
				targetUserId: order.userId,
				data: { orderId: order.id, chainId: order.chainId, txHash: order.txHash },
			});
		}
		return c.json(order, 200);
	}, getResponseDefWithAuth('/api/admin/check-crypto-payment-order')),
);

app.post(
	'/get-billing-sales-summary',
	describeRoute(omitResAndReq(apiDef['/api/admin/get-billing-sales-summary'])),
	validator('json', apiDef['/api/admin/get-billing-sales-summary'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/get-billing-sales-summary', Env>) => {
		const body = c.req.valid('json');
		const db = getDb(c.env);
		const where = and(
			eq(cryptoPaymentOrders.status, 'paid'),
			sql`${cryptoPaymentOrders.paidAt} >= ${body.from}`,
			sql`${cryptoPaymentOrders.paidAt} < ${body.to}`,
		);
		const total = await db
			.select({
				count: sql<number>`count(*)`,
				grossAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxIncludedAmountBaseUnits} as integer)), 0)`,
				netAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxExcludedAmountBaseUnits} as integer)), 0)`,
				taxAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxAmountBaseUnits} as integer)), 0)`,
			})
			.from(cryptoPaymentOrders)
			.where(where)
			.get();
		const byCurrency = await db
			.select({
				taxCurrency: cryptoPaymentOrders.taxCurrency,
				decimals: cryptoPaymentOrders.decimals,
				count: sql<number>`count(*)`,
				grossAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxIncludedAmountBaseUnits} as integer)), 0)`,
				netAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxExcludedAmountBaseUnits} as integer)), 0)`,
				taxAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxAmountBaseUnits} as integer)), 0)`,
			})
			.from(cryptoPaymentOrders)
			.where(where)
			.groupBy(cryptoPaymentOrders.taxCurrency, cryptoPaymentOrders.decimals)
			.orderBy(asc(cryptoPaymentOrders.taxCurrency), asc(cryptoPaymentOrders.decimals));
		const byRate = await db
			.select({
				taxName: cryptoPaymentOrders.taxName,
				taxRate: cryptoPaymentOrders.taxRate,
				taxCurrency: cryptoPaymentOrders.taxCurrency,
				decimals: cryptoPaymentOrders.decimals,
				count: sql<number>`count(*)`,
				grossAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxIncludedAmountBaseUnits} as integer)), 0)`,
				netAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxExcludedAmountBaseUnits} as integer)), 0)`,
				taxAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxAmountBaseUnits} as integer)), 0)`,
			})
			.from(cryptoPaymentOrders)
			.where(where)
			.groupBy(cryptoPaymentOrders.taxName, cryptoPaymentOrders.taxRate, cryptoPaymentOrders.taxCurrency, cryptoPaymentOrders.decimals)
			.orderBy(asc(cryptoPaymentOrders.taxName), asc(cryptoPaymentOrders.taxRate), asc(cryptoPaymentOrders.taxCurrency), asc(cryptoPaymentOrders.decimals));
		const byPlan = await db
			.select({
				planId: cryptoPaymentOrders.planId,
				planName: cryptoPaymentOrders.planName,
				taxCurrency: cryptoPaymentOrders.taxCurrency,
				decimals: cryptoPaymentOrders.decimals,
				count: sql<number>`count(*)`,
				grossAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxIncludedAmountBaseUnits} as integer)), 0)`,
				netAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxExcludedAmountBaseUnits} as integer)), 0)`,
				taxAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxAmountBaseUnits} as integer)), 0)`,
			})
			.from(cryptoPaymentOrders)
			.where(where)
			.groupBy(cryptoPaymentOrders.planId, cryptoPaymentOrders.planName, cryptoPaymentOrders.taxCurrency, cryptoPaymentOrders.decimals)
			.orderBy(asc(cryptoPaymentOrders.planName), asc(cryptoPaymentOrders.taxCurrency), asc(cryptoPaymentOrders.decimals));
		const byAsset = await db
			.select({
				assetId: cryptoPaymentOrders.assetId,
				tokenSymbol: cryptoPaymentOrders.tokenSymbol,
				tokenName: cryptoPaymentOrders.tokenName,
				taxCurrency: cryptoPaymentOrders.taxCurrency,
				decimals: cryptoPaymentOrders.decimals,
				count: sql<number>`count(*)`,
				grossAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxIncludedAmountBaseUnits} as integer)), 0)`,
				netAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxExcludedAmountBaseUnits} as integer)), 0)`,
				taxAmountBaseUnits: sql<string>`coalesce(sum(cast(${cryptoPaymentOrders.taxAmountBaseUnits} as integer)), 0)`,
			})
			.from(cryptoPaymentOrders)
			.where(where)
			.groupBy(cryptoPaymentOrders.assetId, cryptoPaymentOrders.tokenSymbol, cryptoPaymentOrders.tokenName, cryptoPaymentOrders.taxCurrency, cryptoPaymentOrders.decimals)
			.orderBy(asc(cryptoPaymentOrders.tokenSymbol), asc(cryptoPaymentOrders.taxCurrency), asc(cryptoPaymentOrders.decimals));
		const normalizeBucket = <T extends { count: number; grossAmountBaseUnits: string; netAmountBaseUnits: string; taxAmountBaseUnits: string }>(row: T): T => ({
			...row,
			grossAmountBaseUnits: String(row.grossAmountBaseUnits),
			netAmountBaseUnits: String(row.netAmountBaseUnits),
			taxAmountBaseUnits: String(row.taxAmountBaseUnits),
		});
		return c.json({
			from: body.from,
			to: body.to,
			count: total?.count ?? 0,
			grossAmountBaseUnits: String(total?.grossAmountBaseUnits ?? '0'),
			netAmountBaseUnits: String(total?.netAmountBaseUnits ?? '0'),
			taxAmountBaseUnits: String(total?.taxAmountBaseUnits ?? '0'),
			byCurrency: byCurrency.map(normalizeBucket),
			byRate: byRate.map(normalizeBucket),
			byPlan: byPlan.map(normalizeBucket),
			byAsset: byAsset.map(normalizeBucket),
		}, 200);
	}, getResponseDefWithAuth('/api/admin/get-billing-sales-summary')),
);

export const adminBillingRoutes = app;
