import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, sql } from 'drizzle-orm';
import { genEaidx } from '../../shared/eaid-x';
import { apiDef, type JsonCtx } from '../../shared/api';
import { fileReports, files, tokens, users } from '../scheme/index';
import { getDb } from '../utils/db';
import { apiError } from '../utils/api-error';
import { omitResAndReq } from '../utils/omit';
import { isTurnstileConfigured, verifyTurnstile } from '../utils/turnstile';
import { getRequestIp } from '../utils/request-ip';
import { tokenToDigest } from '../utils/crypto';
import { getAppName } from '../utils/app-name';
import { sendEmailLines } from '../utils/email';
import { runContextBackgroundTask } from '../utils/background-task';
import { assertRateLimit, rateLimitKey } from '../utils/rate-limit-binding';

const app = new Hono<{ Bindings: Env }>();

async function getOptionalReporterUser(c: JsonCtx<'/api/file-reports/create', Env>): Promise<{ id: string; username: string } | null> {
	const authorization = c.req.header('Authorization');
	if (!authorization?.startsWith('Bearer ')) return null;

	const token = authorization.slice(7);
	const tokenBytes = await tokenToDigest(token);
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
		.where(tokenBytes === null ? sql`false` : eq(tokens.token, tokenBytes))
		.get();

	if (!tokenRecord || tokenRecord.isRevoked || tokenRecord.isSuspended) return null;
	return { id: tokenRecord.userId, username: tokenRecord.username };
}

async function sendReporterCopy(env: Env, report: {
	id: string;
	fileId: string;
	reporterEmail: string;
	createdAt: number;
}): Promise<void> {
	const appName = await getAppName(env);
	await sendEmailLines(env, report.reporterEmail, `${appName} 通報を受け付けました (自動返信)`, [
		`${appName} への通報を受け付けました。`,
		'',
		`受付日時: ${new Date(report.createdAt).toISOString()}`,
		`通報ID: ${report.id}`,
		`対象ファイルID: ${report.fileId}`,
		'',
		'通報内容は管理者が確認します。必要に応じて管理者から連絡する場合があります。',
		'このメールは通報フォームに入力されたメールアドレス宛てに送信しています。',
	]);
}

app.post(
	'/create',
	describeRoute(omitResAndReq(apiDef['/api/file-reports/create'])),
	validator('json', apiDef['/api/file-reports/create'].req),
	describeResponse(async (c: JsonCtx<'/api/file-reports/create', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		await assertRateLimit(c.env, 'PUBLIC_FORM_RATE_LIMITER', rateLimitKey('file-report', body.fileId, getRequestIp(c.req)));
		const reporterUser = await getOptionalReporterUser(c);
		const file = await db.select({ id: files.id, userId: files.userId }).from(files).where(eq(files.id, body.fileId)).get();
		if (!file) throw apiError(404, 'FILE_NOT_FOUND');
		if (reporterUser?.id === file.userId) throw apiError(403, 'FORBIDDEN');

		const turnstileSecret = c.env.TURNSTILE_SECRET as string;
		if (isTurnstileConfigured(c.env)) {
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
			reporterEmail: body.reporterEmail,
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
		runContextBackgroundTask(c, sendReporterCopy(c.env, {
			id,
			fileId: body.fileId,
			reporterEmail: body.reporterEmail,
			createdAt: now,
		}), 'Failed to send file report copy:');

		return c.json({ ok: true, id }, 200);
	}, apiDef['/api/file-reports/create'].res),
);

export const fileReportRoutes = app;
