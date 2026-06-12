import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { appSettings, paymentChains } from '../scheme/index';
import { getDb } from '../utils/db';
import { canAcceptCryptoPayments } from '../utils/crypto-payments';
import { getPaymentChainRpcUrl } from '../utils/payment-rpc';
import { isTurnstileConfigured } from '../utils/turnstile';
import { DEFAULT_APP_NAME, DEFAULT_BILLING_RESIDENCY_STATEMENT } from '../../shared/app-settings';
import { runBackgroundTask } from '../utils/background-task';
import { isGoogleAuthConfigured } from './google-auth';

const app = new Hono<{ Bindings: Env }>();
const metaCacheName = 'api-meta-response';
const metaCacheMaxAgeSeconds = 10;
const metaSettingKeys = [
	'app_name',
	'registration_mode',
	'google_required',
	'terms_url',
	'terms_updated_at',
	'privacy_policy_url',
	'plan_purchase_terms_url',
	'billing_residency_statement',
] as const;

type MetaResponse = {
	appName: string;
	registrationEnabled: boolean;
	passphraseRequired: boolean;
	termsUrl: string;
	termsUpdatedAt: string;
	privacyPolicyUrl: string;
	planPurchaseTermsUrl: string;
	turnstileEnabled: boolean;
	turnstileSiteKey: string;
	googleAuthEnabled: boolean;
	googleRequired: boolean;
	indieAuthEnabled: boolean;
	cryptoPaymentsEnabled: boolean;
	billingResidencyStatement: string;
	reownProjectId: string;
	walletConnectChainIds: number[];
};

function createMetaResponse(data: MetaResponse): Response {
	return new Response(JSON.stringify(data), {
		headers: {
			'Content-Type': 'application/json; charset=UTF-8',
			'Cache-Control': `public, max-age=${metaCacheMaxAgeSeconds}`,
			'Expires': new Date(Date.now() + metaCacheMaxAgeSeconds * 1000).toUTCString(),
		},
	});
}

function createMetaCacheRequest(request: Request): Request {
	const url = new URL(request.url);
	url.search = '';
	return new Request(url.toString(), { method: 'GET' });
}

app.get('/meta', async (c) => {
	const cacheRequest = createMetaCacheRequest(c.req.raw);
	const cache = await caches.open(metaCacheName);
	const cached = await cache.match(cacheRequest);
	if (cached !== undefined) {
		const headers = new Headers(cached.headers);
		headers.set('X-Cache', 'HIT');
		return new Response(cached.body, {
			status: cached.status,
			statusText: cached.statusText,
			headers,
		});
	}

	const db = getDb(c.env);

	try {
		const settingRows = await db
			.select({ key: appSettings.key, value: appSettings.value })
			.from(appSettings)
			.where(inArray(appSettings.key, metaSettingKeys));
		const settings = new Map(settingRows.map(setting => [setting.key, setting.value]));

		const appNameSetting = settings.get('app_name')?.trim();
		const appName = appNameSetting === '' || appNameSetting == null ? DEFAULT_APP_NAME : appNameSetting;
		const mode = settings.get('registration_mode') ?? 'passphrase';
		const googleRequired = settings.get('google_required') === 'true';
		const googleAuthEnabled = isGoogleAuthConfigured(c.env);
		const cryptoPaymentsEnabled = await canAcceptCryptoPayments(c.env);
		const walletConnectChains = cryptoPaymentsEnabled
			? await db
				.select({ chainId: paymentChains.chainId })
				.from(paymentChains)
				.where(eq(paymentChains.isEnabled, true))
			: [];

		const response = createMetaResponse({
			appName,
			registrationEnabled: mode !== 'closed',
			passphraseRequired: mode === 'passphrase',
			termsUrl: settings.get('terms_url') ?? '',
			termsUpdatedAt: settings.get('terms_updated_at') ?? '',
			privacyPolicyUrl: settings.get('privacy_policy_url') ?? '',
			planPurchaseTermsUrl: settings.get('plan_purchase_terms_url') ?? '',
			turnstileEnabled: isTurnstileConfigured(c.env),
			turnstileSiteKey: isTurnstileConfigured(c.env) ? c.env.TURNSTILE_SITE_KEY : '',
			googleAuthEnabled,
			googleRequired,
			indieAuthEnabled: true,
			cryptoPaymentsEnabled,
			billingResidencyStatement: (() => {
				const statement = settings.get('billing_residency_statement')?.trim();
				return statement === '' || statement == null ? DEFAULT_BILLING_RESIDENCY_STATEMENT : statement;
			})(),
			reownProjectId: c.env.REOWN_PROJECT_ID,
			walletConnectChainIds: walletConnectChains
				.map(chain => chain.chainId)
				.filter(chainId => getPaymentChainRpcUrl(c.env, chainId) !== null),
		});
		const headers = new Headers(response.headers);
		headers.set('X-Cache', 'MISS');
		const responseWithCacheHeader = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
		runBackgroundTask(
			promise => c.executionCtx.waitUntil(promise),
			cache.put(cacheRequest, responseWithCacheHeader.clone()),
			'Failed to put meta response into cache:',
		);
		return responseWithCacheHeader;
	} catch {
		return createMetaResponse({
			appName: DEFAULT_APP_NAME,
			registrationEnabled: true,
			passphraseRequired: true,
			termsUrl: '',
			termsUpdatedAt: '',
			privacyPolicyUrl: '',
			planPurchaseTermsUrl: '',
			turnstileEnabled: false,
			turnstileSiteKey: '',
			googleAuthEnabled: false,
			googleRequired: false,
			indieAuthEnabled: true,
			cryptoPaymentsEnabled: false,
			billingResidencyStatement: DEFAULT_BILLING_RESIDENCY_STATEMENT,
			reownProjectId: '',
			walletConnectChainIds: [],
		});
	}
});

export const metaRoutes = app;
