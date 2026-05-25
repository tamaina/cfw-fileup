import * as v from 'valibot';
import { errorResponse, IdString, PageRequestFields, pagedResponse } from '../api.schemas.js';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';

const EthereumAddress = v.pipe(v.string(), v.regex(/^0x[a-fA-F0-9]{40}$/));
const TransactionHash = v.pipe(v.string(), v.regex(/^0x[a-fA-F0-9]{64}$/));
const BigIntString = v.pipe(v.string(), v.regex(/^(0|[1-9]\d*)$/));

const PaymentChainResponse = v.pipe(
	v.object({
		chainId: v.number(),
		name: v.string(),
		nativeCurrencyName: v.string(),
		nativeCurrencySymbol: v.string(),
		nativeCurrencyDecimals: v.number(),
		blockExplorerUrl: v.nullable(v.string()),
		confirmationsRequired: v.number(),
		isEnabled: v.boolean(),
		isRpcConfigured: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'PaymentChain' }),
);

const PaymentAssetResponse = v.pipe(
	v.object({
		id: IdString,
		symbol: v.string(),
		name: v.string(),
		isEnabled: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'PaymentAsset' }),
);

const PaymentAssetDeploymentResponse = v.pipe(
	v.object({
		id: IdString,
		assetId: IdString,
		assetSymbol: v.string(),
		assetName: v.string(),
		chainId: v.number(),
		chainName: v.string(),
		contractAddress: EthereumAddress,
		decimals: v.number(),
		recipientAddress: EthereumAddress,
		isEnabled: v.boolean(),
		isRpcConfigured: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'PaymentAssetDeployment' }),
);

const PlanSummaryResponse = v.object({
	id: IdString,
	name: v.string(),
});

const PaymentAssetPlanPriceResponse = v.pipe(
	v.object({
		id: IdString,
		deploymentId: IdString,
		assetId: IdString,
		assetSymbol: v.string(),
		assetName: v.string(),
		chainId: v.number(),
		chainName: v.string(),
		confirmationsRequired: v.number(),
		contractAddress: EthereumAddress,
		recipientAddress: EthereumAddress,
		decimals: v.number(),
		plan: PlanSummaryResponse,
		amountBaseUnits: BigIntString,
		durationDays: v.number(),
		isEnabled: v.boolean(),
		isRpcConfigured: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'PaymentAssetPlanPrice' }),
);

const CryptoPaymentOrderStatus = v.picklist(['pending', 'paid', 'expired', 'failed']);
const CryptoPaymentOrderResponse = v.pipe(
	v.object({
		id: IdString,
		userId: IdString,
		payerWalletId: v.nullable(IdString),
		payerAddress: EthereumAddress,
		priceId: v.nullable(IdString),
		deploymentId: v.nullable(IdString),
		planId: IdString,
		chainId: v.number(),
		chainName: v.string(),
		assetSymbol: v.string(),
		assetName: v.string(),
		contractAddress: EthereumAddress,
		recipientAddress: EthereumAddress,
		amountBaseUnits: BigIntString,
		decimals: v.number(),
		durationDays: v.number(),
		status: CryptoPaymentOrderStatus,
		txHash: v.nullable(TransactionHash),
		createdAt: v.number(),
		updatedAt: v.number(),
		expiresAt: v.number(),
		paidAt: v.nullable(v.number()),
	}),
	v.metadata({ ref: 'CryptoPaymentOrder' }),
);

const ChainInput = {
	chainId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
	nativeCurrencyName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
	nativeCurrencySymbol: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(20)),
	nativeCurrencyDecimals: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255)),
	blockExplorerUrl: v.optional(v.nullable(v.pipe(v.string(), v.url(), v.maxLength(500))), null),
	confirmationsRequired: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 1),
	isEnabled: v.optional(v.boolean(), true),
} as const;

const AssetInput = {
	symbol: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(20)),
	name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
	isEnabled: v.optional(v.boolean(), true),
} as const;

const DeploymentInput = {
	assetId: IdString,
	chainId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	contractAddress: EthereumAddress,
	decimals: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255)),
	recipientAddress: EthereumAddress,
	isEnabled: v.optional(v.boolean(), true),
} as const;

const PriceInput = {
	deploymentId: IdString,
	planId: IdString,
	amountBaseUnits: BigIntString,
	durationDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650)),
	isEnabled: v.optional(v.boolean(), true),
} as const;

const OkResponse = { 200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } } };
const AuthErrors = {};

export const billingApiDef = {
	'/api/billing/list-crypto-offers': {
		summary: 'List enabled crypto payment offers',
		tags: ['billing'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(PaymentAssetPlanPriceResponse) } } }, ...AuthErrors },
	},
	'/api/billing/create-crypto-order': {
		summary: 'Create a crypto payment order',
		tags: ['billing'],
		req: v.object({ priceId: IdString, payerWalletId: IdString }),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: CryptoPaymentOrderResponse } } },
			400: errorResponse('Payment wallet not found', ['WALLET_NOT_FOUND']),
			404: errorResponse('Payment price not found', ['PAYMENT_PRICE_NOT_FOUND']),
		},
	},
	'/api/billing/confirm-crypto-order': {
		summary: 'Confirm a crypto payment order by transaction hash',
		tags: ['billing'],
		req: v.object({ orderId: IdString, txHash: TransactionHash }),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: CryptoPaymentOrderResponse } } },
			400: errorResponse('Invalid payment transaction', ['PAYMENT_CHAIN_RPC_NOT_CONFIGURED', 'PAYMENT_ORDER_EXPIRED', 'PAYMENT_TRANSACTION_ALREADY_USED', 'PAYMENT_TRANSACTION_INVALID']),
			404: errorResponse('Payment order not found', ['PAYMENT_ORDER_NOT_FOUND']),
		},
	},
	'/api/billing/list-my-payments': {
		summary: 'List current user crypto payments',
		tags: ['billing'],
		req: v.object(PageRequestFields),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(CryptoPaymentOrderResponse) } } } },
	},
	'/api/admin/list-payment-chains': {
		summary: 'List payment chains',
		tags: ['admin', 'billing'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(PaymentChainResponse) } } } },
	},
	'/api/admin/create-payment-chain': {
		summary: 'Create payment chain',
		tags: ['admin', 'billing'],
		req: v.object(ChainInput),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PaymentChainResponse } } } },
	},
	'/api/admin/update-payment-chain': {
		summary: 'Update payment chain',
		tags: ['admin', 'billing'],
		req: v.object({ ...ChainInput }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PaymentChainResponse } } }, 404: errorResponse('Payment chain not found', ['PAYMENT_CHAIN_NOT_FOUND']) },
	},
	'/api/admin/delete-payment-chain': {
		summary: 'Delete payment chain',
		tags: ['admin', 'billing'],
		req: v.object({ chainId: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
		res: { ...OkResponse, 404: errorResponse('Payment chain not found', ['PAYMENT_CHAIN_NOT_FOUND']) },
	},
	'/api/admin/list-payment-assets': {
		summary: 'List payment assets',
		tags: ['admin', 'billing'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(PaymentAssetResponse) } } } },
	},
	'/api/admin/create-payment-asset': {
		summary: 'Create payment asset',
		tags: ['admin', 'billing'],
		req: v.object(AssetInput),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PaymentAssetResponse } } } },
	},
	'/api/admin/update-payment-asset': {
		summary: 'Update payment asset',
		tags: ['admin', 'billing'],
		req: v.object({ assetId: IdString, ...AssetInput }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PaymentAssetResponse } } }, 404: errorResponse('Payment asset not found', ['PAYMENT_ASSET_NOT_FOUND']) },
	},
	'/api/admin/delete-payment-asset': {
		summary: 'Delete payment asset',
		tags: ['admin', 'billing'],
		req: v.object({ assetId: IdString }),
		res: { ...OkResponse, 404: errorResponse('Payment asset not found', ['PAYMENT_ASSET_NOT_FOUND']) },
	},
	'/api/admin/list-payment-asset-deployments': {
		summary: 'List payment asset deployments',
		tags: ['admin', 'billing'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(PaymentAssetDeploymentResponse) } } } },
	},
	'/api/admin/create-payment-asset-deployment': {
		summary: 'Create payment asset deployment',
		tags: ['admin', 'billing'],
		req: v.object(DeploymentInput),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PaymentAssetDeploymentResponse } } }, 400: errorResponse('Payment deployment already exists', ['PAYMENT_ASSET_DEPLOYMENT_ALREADY_EXISTS']), 404: errorResponse('Payment chain or asset not found', ['PAYMENT_CHAIN_NOT_FOUND', 'PAYMENT_ASSET_NOT_FOUND']) },
	},
	'/api/admin/update-payment-asset-deployment': {
		summary: 'Update payment asset deployment',
		tags: ['admin', 'billing'],
		req: v.object({ deploymentId: IdString, ...DeploymentInput }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PaymentAssetDeploymentResponse } } }, 400: errorResponse('Payment deployment already exists', ['PAYMENT_ASSET_DEPLOYMENT_ALREADY_EXISTS']), 404: errorResponse('Payment deployment not found', ['PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND', 'PAYMENT_CHAIN_NOT_FOUND', 'PAYMENT_ASSET_NOT_FOUND']) },
	},
	'/api/admin/delete-payment-asset-deployment': {
		summary: 'Delete payment asset deployment',
		tags: ['admin', 'billing'],
		req: v.object({ deploymentId: IdString }),
		res: { ...OkResponse, 404: errorResponse('Payment deployment not found', ['PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND']) },
	},
	'/api/admin/list-payment-asset-plan-prices': {
		summary: 'List payment asset plan prices',
		tags: ['admin', 'billing'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(PaymentAssetPlanPriceResponse) } } } },
	},
	'/api/admin/create-payment-asset-plan-price': {
		summary: 'Create payment asset plan price',
		tags: ['admin', 'billing'],
		req: v.object(PriceInput),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PaymentAssetPlanPriceResponse } } }, 404: errorResponse('Payment deployment or plan not found', ['PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND', 'PLAN_NOT_FOUND']) },
	},
	'/api/admin/update-payment-asset-plan-price': {
		summary: 'Update payment asset plan price',
		tags: ['admin', 'billing'],
		req: v.object({ priceId: IdString, ...PriceInput }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PaymentAssetPlanPriceResponse } } }, 404: errorResponse('Payment price, deployment, or plan not found', ['PAYMENT_PRICE_NOT_FOUND', 'PAYMENT_ASSET_DEPLOYMENT_NOT_FOUND', 'PLAN_NOT_FOUND']) },
	},
	'/api/admin/delete-payment-asset-plan-price': {
		summary: 'Delete payment asset plan price',
		tags: ['admin', 'billing'],
		req: v.object({ priceId: IdString }),
		res: { ...OkResponse, 404: errorResponse('Payment price not found', ['PAYMENT_PRICE_NOT_FOUND']) },
	},
	'/api/admin/list-crypto-payment-orders': {
		summary: 'List crypto payment orders',
		tags: ['admin', 'billing'],
		req: v.object(PageRequestFields),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(CryptoPaymentOrderResponse) } } } },
	},
} as const satisfies ApiEndpointDefinitionRecord;
