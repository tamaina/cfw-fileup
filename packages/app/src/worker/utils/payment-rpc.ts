import { isAddress } from 'viem';
import { apiError } from './api-error';

export function getPaymentChainRpcUrls(env: Env): Record<string, string> {
	const raw = (env as unknown as Record<string, unknown>).EVM_CHAIN_RPC_URLS;
	if (typeof raw !== 'string' || raw.trim() === '') return {};

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const urls: Record<string, string> = {};
		for (const [chainId, value] of Object.entries(parsed)) {
			if (!/^[1-9]\d*$/.test(chainId) || typeof value !== 'string') continue;
			try {
				const url = new URL(value);
				if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
				urls[chainId] = value;
			} catch {
				// Ignore invalid entries; callers treat a missing chain entry as unconfigured.
			}
		}
		return urls;
	} catch {
		return {};
	}
}

export function getPaymentChainRpcUrl(env: Env, chainId: number): string | null {
	const url = getPaymentChainRpcUrls(env)[String(chainId)];
	return url || null;
}

export function isPaymentChainRpcConfigured(env: Env, chainId: number): boolean {
	return getPaymentChainRpcUrl(env, chainId) !== null;
}

export function normalizeEthAddress(address: string): `0x${string}` {
	if (!isAddress(address)) throw apiError(400, 'PAYMENT_TRANSACTION_INVALID');
	return address.toLowerCase() as `0x${string}`;
}
