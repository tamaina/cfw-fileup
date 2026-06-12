import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { paymentAssetDeployments, paymentAssetPlanPrices, paymentAssets, paymentChains, plans } from '../scheme/index';
import { getDb } from './db';
import { getPaymentChainRpcUrls } from './payment-rpc';
import { getAppSettingCached } from './app-settings-cache';

export async function canAcceptCryptoPayments(env: Env): Promise<boolean> {
	const db = getDb(env);
	if (await getAppSettingCached(env, 'crypto_payments_enabled') !== 'true') return false;

	const rpcUrls = getPaymentChainRpcUrls(env);
	if (Object.keys(rpcUrls).length === 0) return false;

	const offerChains = await db
		.select({ chainId: paymentChains.chainId })
		.from(paymentAssetPlanPrices)
		.innerJoin(paymentAssets, eq(paymentAssetPlanPrices.assetId, paymentAssets.id))
		.innerJoin(paymentAssetDeployments, eq(paymentAssetDeployments.assetId, paymentAssets.id))
		.innerJoin(paymentChains, eq(paymentAssetDeployments.chainId, paymentChains.chainId))
		.innerJoin(plans, eq(paymentAssetPlanPrices.planId, plans.id))
		.where(and(
			lt(paymentAssetPlanPrices.startsAt, Date.now() + 1),
			eq(paymentAssetDeployments.isEnabled, true),
			eq(paymentAssets.isEnabled, true),
			eq(paymentChains.isEnabled, true),
			eq(plans.isEnabled, true),
			or(isNull(paymentAssetPlanPrices.expiresAt), gt(paymentAssetPlanPrices.expiresAt, Date.now())),
		));

	return offerChains.some(chain => String(chain.chainId) in rpcUrls);
}
