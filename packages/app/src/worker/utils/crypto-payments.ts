import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { appSettings, paymentAssetDeployments, paymentAssetPlanPrices, paymentAssets, paymentChains, plans } from '../scheme/index';
import { getDb } from './db';
import { getPaymentChainRpcUrls } from './payment-rpc';

export async function canAcceptCryptoPayments(env: Env): Promise<boolean> {
	const db = getDb(env);
	const setting = await db
		.select({ value: appSettings.value })
		.from(appSettings)
		.where(eq(appSettings.key, 'crypto_payments_enabled'))
		.get();
	if (setting?.value !== 'true') return false;

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
			eq(paymentAssetPlanPrices.isEnabled, true),
			eq(paymentAssetDeployments.isEnabled, true),
			eq(paymentAssets.isEnabled, true),
			eq(paymentChains.isEnabled, true),
			eq(plans.isEnabled, true),
			or(isNull(paymentAssetPlanPrices.expiresAt), gt(paymentAssetPlanPrices.expiresAt, Date.now())),
		));

	return offerChains.some(chain => rpcUrls[String(chain.chainId)] != null);
}
