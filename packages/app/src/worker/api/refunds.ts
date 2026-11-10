import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { omitResAndReq } from '../utils/omit';
import { createRefundRequest, listRefundViews, closeRefundRequest, prepareRefundRequest, getRefundView } from '../utils/refund-requests';
import { calculateRefundQuote } from '../utils/refund-quote';
import { startRefundTransfer, submitRefundTransfer } from '../utils/refund-transfers';
import { checkRefundRequest } from '../utils/refund-completion';

export const refundUserRoutes = new Hono<{ Bindings: Env }>();
export const refundAdminRoutes = new Hono<{ Bindings: Env }>();
refundUserRoutes.use(authMiddleware);
refundAdminRoutes.use(authMiddleware);
refundAdminRoutes.use(adminMiddleware);

async function quote(env: Env, requestId: string, cutoffAt: number) {
	const view = await getRefundView(env, requestId);
	return calculateRefundQuote(env, view.request.userId, cutoffAt);
}

refundUserRoutes.post('/create-refund-request',
	describeRoute(omitResAndReq(apiDef['/api/billing/create-refund-request'])),
	validator('json', apiDef['/api/billing/create-refund-request'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/create-refund-request', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		return c.json(await createRefundRequest(c.env, user.id, body.idempotencyKey, body.requestedCutoffAt), 200);
	}, getResponseDefWithAuth('/api/billing/create-refund-request')),
);

refundUserRoutes.post('/list-my-refund-requests',
	describeRoute(omitResAndReq(apiDef['/api/billing/list-my-refund-requests'])),
	validator('json', apiDef['/api/billing/list-my-refund-requests'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/list-my-refund-requests', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		return c.json(await listRefundViews(c.env, user.id, body.cursor), 200);
	}, getResponseDefWithAuth('/api/billing/list-my-refund-requests')),
);

refundUserRoutes.post('/cancel-refund-request',
	describeRoute(omitResAndReq(apiDef['/api/billing/cancel-refund-request'])),
	validator('json', apiDef['/api/billing/cancel-refund-request'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/cancel-refund-request', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		return c.json(await closeRefundRequest(c.env, body.requestId, body.version, 'cancelled', '', user.id), 200);
	}, getResponseDefWithAuth('/api/billing/cancel-refund-request')),
);

refundAdminRoutes.post('/list-refund-requests',
	describeRoute(omitResAndReq(apiDef['/api/admin/list-refund-requests'])),
	validator('json', apiDef['/api/admin/list-refund-requests'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/list-refund-requests', Env>) => {
		const body = c.req.valid('json');
		return c.json(await listRefundViews(c.env, undefined, body.cursor), 200);
	}, getResponseDefWithAuth('/api/admin/list-refund-requests')),
);

refundAdminRoutes.post('/quote-refund',
	describeRoute(omitResAndReq(apiDef['/api/admin/quote-refund'])),
	validator('json', apiDef['/api/admin/quote-refund'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/quote-refund', Env>) => {
		const body = c.req.valid('json');
		return c.json(await quote(c.env, body.requestId, body.effectiveCutoffAt), 200);
	}, getResponseDefWithAuth('/api/admin/quote-refund')),
);

refundAdminRoutes.post('/prepare-refund',
	describeRoute(omitResAndReq(apiDef['/api/admin/prepare-refund'])),
	validator('json', apiDef['/api/admin/prepare-refund'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/prepare-refund', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		return c.json(await prepareRefundRequest(c.env, body.requestId, user.id, body.version, body.effectiveCutoffAt, body.adjustmentReason, body.quoteRevision), 200);
	}, getResponseDefWithAuth('/api/admin/prepare-refund')),
);

refundAdminRoutes.post('/reject-refund',
	describeRoute(omitResAndReq(apiDef['/api/admin/reject-refund'])),
	validator('json', apiDef['/api/admin/reject-refund'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/reject-refund', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		return c.json(await closeRefundRequest(c.env, body.requestId, body.version, 'rejected', body.reason, undefined, user.id), 200);
	}, getResponseDefWithAuth('/api/admin/reject-refund')),
);

refundAdminRoutes.post('/start-refund-transfer',
	describeRoute(omitResAndReq(apiDef['/api/admin/start-refund-transfer'])),
	validator('json', apiDef['/api/admin/start-refund-transfer'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/start-refund-transfer', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		return c.json(await startRefundTransfer(c.env, body.requestId, body.transferId, body.version, body.senderAddress, user.id), 200);
	}, getResponseDefWithAuth('/api/admin/start-refund-transfer')),
);

refundAdminRoutes.post('/submit-refund-transfer',
	describeRoute(omitResAndReq(apiDef['/api/admin/submit-refund-transfer'])),
	validator('json', apiDef['/api/admin/submit-refund-transfer'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/submit-refund-transfer', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		return c.json(await submitRefundTransfer(c.env, body.requestId, body.transferId, body.txHash, user.id), 200);
	}, getResponseDefWithAuth('/api/admin/submit-refund-transfer')),
);

refundAdminRoutes.post('/check-refund',
	describeRoute(omitResAndReq(apiDef['/api/admin/check-refund'])),
	validator('json', apiDef['/api/admin/check-refund'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/check-refund', Env>) => {
		const user = c.get('user');
		const body = c.req.valid('json');
		return c.json(await checkRefundRequest(c.env, body.requestId, user.id), 200);
	}, getResponseDefWithAuth('/api/admin/check-refund')),
);

refundUserRoutes.post('/show-refund-request',
	describeRoute(omitResAndReq(apiDef['/api/billing/show-refund-request'])),
	validator('json', apiDef['/api/billing/show-refund-request'].req),
	describeResponse(async (c: JsonCtx<'/api/billing/show-refund-request', Env>) => {
		const body = c.req.valid('json');
		return c.json(await getRefundView(c.env, body.requestId, c.get('user').id), 200);
	}, getResponseDefWithAuth('/api/billing/show-refund-request')),
);
refundAdminRoutes.post('/show-refund-request',
	describeRoute(omitResAndReq(apiDef['/api/admin/show-refund-request'])),
	validator('json', apiDef['/api/admin/show-refund-request'].req),
	describeResponse(async (c: JsonCtx<'/api/admin/show-refund-request', Env>) => {
		const body = c.req.valid('json');
		return c.json(await getRefundView(c.env, body.requestId), 200);
	}, getResponseDefWithAuth('/api/admin/show-refund-request')),
);
