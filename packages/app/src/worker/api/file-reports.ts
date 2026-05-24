import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq } from 'drizzle-orm';
import { genEaidx } from '../../shared/eaid-x';
import { apiDef, type JsonCtx } from '../../shared/api';
import { fileReports, files, tokens, users } from '../scheme/index';
import { getDb } from '../utils/db';
import { apiError } from '../utils/api-error';
import { omitResAndReq } from '../utils/omit';
import { verifyTurnstile } from '../utils/turnstile';
import { getRequestIp } from '../utils/request-ip';

const app = new Hono<{ Bindings: Env }>();

async function getOptionalReporterUser(c: JsonCtx<'/api/file-reports/create', Env>): Promise<{ id: string; username: string } | null> {
	const authorization = c.req.header('Authorization');
	if (!authorization?.startsWith('Bearer ')) return null;

	const token = authorization.slice(7);
	const db = getDb(c.env);
	const tokenRecord = await db
		.select({
			userId: tokens.userId,
			username: users.username,
			isRevoked: tokens.isRevoked,
			isSuspended: users.isSuspended,
		})
		.from(tokens)
		.innerJoin(users, eq(tokens.userId, users.id))
		.where(eq(tokens.token, token))
		.get();

	if (!tokenRecord || tokenRecord.isRevoked || tokenRecord.isSuspended) return null;
	return { id: tokenRecord.userId, username: tokenRecord.username };
}

app.post(
	'/create',
	describeRoute(omitResAndReq(apiDef['/api/file-reports/create'])),
	validator('json', apiDef['/api/file-reports/create'].req),
	describeResponse(async (c: JsonCtx<'/api/file-reports/create', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const reporterUser = await getOptionalReporterUser(c);
		const file = await db.select({ id: files.id }).from(files).where(eq(files.id, body.fileId)).get();
		if (!file) throw apiError(404, 'FILE_NOT_FOUND');

		const turnstileSecret = c.env.TURNSTILE_SECRET as string;
		if (turnstileSecret !== '') {
			if (!body.turnstileToken) throw apiError(400, 'TURNSTILE_TOKEN_IS_REQUIRED');
			if (!await verifyTurnstile(body.turnstileToken, turnstileSecret)) {
				throw apiError(400, 'TURNSTILE_VERIFICATION_FAILED');
			}
		}

		const now = Date.now();
		const id = genEaidx(now);
		await db.insert(fileReports).values({
			id,
			fileId: body.fileId,
			reporterUserId: reporterUser?.id ?? null,
			reporterName: body.reporterName,
			reporterEmail: body.reporterEmail ?? null,
			reasonId: body.reasonId,
			relationshipId: body.relationshipId,
			contact: body.contact ?? null,
			summary: body.summary,
			detail: body.detail,
			status: 'open',
			adminNote: '',
			reporterIpAddress: getRequestIp(c.req),
			reporterUserAgent: c.req.header('User-Agent') ?? null,
			createdAt: now,
			updatedAt: now,
		});

		return c.json({ ok: true, id }, 200);
	}, apiDef['/api/file-reports/create'].res),
);

export const fileReportRoutes = app;
