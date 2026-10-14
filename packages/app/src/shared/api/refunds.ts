import * as v from 'valibot';
import { errorResponse } from '../api.schemas';
import type { ApiEndpointDefinitionRecord } from '../api.types';

const Timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000));
const Version = v.pipe(v.number(), v.integer(), v.minValue(0));
const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const Address = v.pipe(v.string(), v.regex(/^0x[a-fA-F0-9]{40}$/));
const Amount = v.pipe(v.string(), v.regex(/^(0|[1-9]\d*)$/));
const Reason = v.pipe(v.string(), v.maxLength(1000));
const Source = v.object({ id: Id, payerAddress: Address, chainId: v.number(), contractAddress: Address, decimals: v.number() });
const Line = v.object({
	id: Id, assignmentId: Id, sourceOrder: Source, amountBaseUnits: Amount,
	taxName: v.string(), taxRate: v.string(), taxCurrency: v.string(),
	taxAmountBaseUnits: Amount, taxExcludedAmountBaseUnits: Amount,
});
const Group = v.object({
	id: Id, payerAddress: Address, chainId: v.number(), contractAddress: Address, decimals: v.number(),
	amountBaseUnits: Amount, tokenSymbol: v.string(), chainName: v.string(), lines: v.array(Line),
});
export const RefundQuoteSchema = v.object({
	revision: Version, effectiveCutoffAt: Timestamp,
	assignments: v.array(v.object({ id: Id, startsAt: Timestamp, expiresAt: Timestamp })),
	groups: v.array(Group), reviewReasons: v.array(v.string()),
});
export type RefundQuote = v.InferOutput<typeof RefundQuoteSchema>;
export const RefundSellerSchema = v.object({ name: v.string(), address: v.string(), invoiceRegistrationNumber: v.string() });
export type RefundSeller = v.InferOutput<typeof RefundSellerSchema>;
const Request = v.object({
	id: Id, userId: Id, idempotencyKey: Id, requestedCutoffAt: Timestamp,
	requestedMode: v.picklist(['immediate', 'scheduled']), effectiveCutoffAt: v.nullable(Timestamp),
	adjustmentReason: Reason, decisionReason: Reason, actorUserId: v.nullable(Id),
	status: v.picklist(['requested', 'review_required', 'prepared', 'processing', 'completed', 'rejected', 'cancelled']),
	version: Version, quote: v.nullable(RefundQuoteSchema), seller: v.nullable(RefundSellerSchema),
	createdAt: Timestamp, updatedAt: Timestamp, completedAt: v.nullable(Timestamp),
});
const Transfer = v.object({
	id: Id, requestId: Id, chainId: v.number(), confirmationsRequired: v.number(), senderAddress: v.nullable(Address), txHash: v.nullable(v.string()),
	status: v.picklist(['prepared', 'broadcast_pending', 'submitted', 'verified']), version: Version,
	startedAt: v.nullable(Timestamp), blockHash: v.nullable(v.string()), blockNumber: v.nullable(v.string()), logIndex: v.nullable(v.number()),
});
export const RefundViewSchema = v.object({ request: Request, transfers: v.array(Transfer) });
export type RefundView = v.InferOutput<typeof RefundViewSchema>;
const success = <const S extends v.GenericSchema>(schema: S) => ({
	200: { description: 'Success', content: { 'application/json': { vSchema: schema } } },
	400: errorResponse('Invalid request'), 404: errorResponse('Not found'), 409: errorResponse('Billing conflict'),
});
const requestVersion = { requestId: Id, version: Version };
export const refundsApiDef = {
	'/api/billing/create-refund-request': {
		summary: 'Request a refund without cancelling entitlement', tags: ['billing'],
		req: v.object({ idempotencyKey: Id, requestedCutoffAt: v.nullable(Timestamp) }), res: success(RefundViewSchema),
	},
	'/api/billing/list-my-refund-requests': { summary: 'List my refund requests and evidence', tags: ['billing'], req: v.object({ cursor: v.optional(v.nullable(Id), null) }), res: success(v.array(RefundViewSchema)) },
	'/api/billing/show-refund-request': { summary: 'Get my refund request and evidence', tags: ['billing'], req: v.object({ requestId: Id }), res: success(RefundViewSchema) },
	'/api/billing/cancel-refund-request': { summary: 'Cancel before any transfer starts', tags: ['billing'], req: v.object(requestVersion), res: success(RefundViewSchema) },
	'/api/admin/list-refund-requests': { summary: 'List refund requests', tags: ['admin'], req: v.object({ cursor: v.optional(v.nullable(Id), null) }), res: success(v.array(RefundViewSchema)) },
	'/api/admin/show-refund-request': { summary: 'Get a refund request and evidence', tags: ['admin'], req: v.object({ requestId: Id }), res: success(RefundViewSchema) },
	'/api/admin/quote-refund': {
		summary: 'Recalculate refund from original cash funding', tags: ['admin'], req: v.object({ requestId: Id, effectiveCutoffAt: Timestamp }), res: success(RefundQuoteSchema),
	},
	'/api/admin/prepare-refund': {
		summary: 'Approve and reserve a refund schedule', tags: ['admin'],
		req: v.object({ ...requestVersion, effectiveCutoffAt: Timestamp, adjustmentReason: Reason, quoteRevision: Version }), res: success(RefundViewSchema),
	},
	'/api/admin/reject-refund': { summary: 'Reject before transfer starts', tags: ['admin'], req: v.object({ ...requestVersion, reason: v.pipe(Reason, v.minLength(1)) }), res: success(RefundViewSchema) },
	'/api/admin/start-refund-transfer': {
		summary: 'Reserve a single wallet broadcast attempt', tags: ['admin'], req: v.object({ ...requestVersion, transferId: Id, senderAddress: Address }), res: success(RefundViewSchema),
	},
	'/api/admin/submit-refund-transfer': {
		summary: 'Record the broadcast transaction without changing entitlement', tags: ['admin'],
		req: v.object({ requestId: Id, transferId: Id, txHash: v.pipe(v.string(), v.regex(/^0x[a-fA-F0-9]{64}$/)) }), res: success(RefundViewSchema),
	},
	'/api/admin/check-refund': { summary: 'Verify every group before atomic cancellation', tags: ['admin'], req: v.object({ requestId: Id }), res: success(RefundViewSchema) },
} as const satisfies ApiEndpointDefinitionRecord;
