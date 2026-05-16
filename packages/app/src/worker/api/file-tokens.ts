import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, and } from 'drizzle-orm';
import { buckets, files, fileAccessTokens } from '../scheme/index';
import { getDb } from '../utils/db';
import { generateToken } from '../utils/crypto';
import { genEaidx, parseEaidx } from '../../shared/eaid-x';
import { authMiddleware } from '../middleware/auth';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';
import { verifyTurnstile } from '../utils/turnstile';

const app = new Hono<{ Bindings: Env }>();

app.post(
	'/create',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/file-tokens/create'])),
	validator('json', apiDef['/api/file-tokens/create'].req),
	describeResponse(async (c: JsonCtx<'/api/file-tokens/create', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (body.expiresIn !== null && body.expiresIn <= 0) {
			throw new HTTPException(400, { message: 'expiresIn must be a positive number or null' });
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.name, body.bucketName)).get();
		if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });
		if (bucket.userId !== user.id && !user.isAdmin) throw new HTTPException(403, { message: 'Forbidden' });

		const file = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, bucket.id), eq(files.path, body.filePath)))
			.get();
		if (!file) throw new HTTPException(404, { message: 'File not found' });
		if (!file.isClosed) throw new HTTPException(400, { message: 'File is not closed' });
		if (file.isPublic) throw new HTTPException(400, { message: 'Cannot create token for public file' });

		const id = genEaidx(Date.now());
		const token = generateToken();
		const expiresAt = body.expiresIn != null ? Date.now() + body.expiresIn * 1000 : null;

		await db.insert(fileAccessTokens).values({ id, fileId: file.id, token, expiresAt });

		return c.json({ id, token, expiresAt }, 200);
	}, getResponseDefWithAuth('/api/file-tokens/create')),
);

app.post(
	'/list',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/file-tokens/list'])),
	validator('json', apiDef['/api/file-tokens/list'].req),
	describeResponse(async (c: JsonCtx<'/api/file-tokens/list', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		const bucket = await db.select().from(buckets).where(eq(buckets.name, body.bucketName)).get();
		if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });
		if (bucket.userId !== user.id && !user.isAdmin) throw new HTTPException(403, { message: 'Forbidden' });

		const file = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, bucket.id), eq(files.path, body.filePath)))
			.get();
		if (!file) throw new HTTPException(404, { message: 'File not found' });

		const rows = await db
			.select()
			.from(fileAccessTokens)
			.where(eq(fileAccessTokens.fileId, file.id));

		return c.json({
			tokens: rows.map((r) => ({
				id: r.id,
				expiresAt: r.expiresAt,
				createdAt: parseEaidx(r.id).date.getTime(),
			})),
		}, 200);
	}, getResponseDefWithAuth('/api/file-tokens/list')),
);

app.post(
	'/delete',
	authMiddleware,
	describeRoute(omitResAndReq(apiDef['/api/file-tokens/delete'])),
	validator('json', apiDef['/api/file-tokens/delete'].req),
	describeResponse(async (c: JsonCtx<'/api/file-tokens/delete', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		const row = await db
			.select({
				tokenId: fileAccessTokens.id,
				fileId: fileAccessTokens.fileId,
				bucketUserId: buckets.userId,
			})
			.from(fileAccessTokens)
			.innerJoin(files, eq(fileAccessTokens.fileId, files.id))
			.innerJoin(buckets, eq(files.bucketId, buckets.id))
			.where(eq(fileAccessTokens.id, body.tokenId))
			.get();

		if (!row) throw new HTTPException(404, { message: 'Token not found' });
		if (row.bucketUserId !== user.id && !user.isAdmin) throw new HTTPException(403, { message: 'Forbidden' });

		await db.delete(fileAccessTokens).where(eq(fileAccessTokens.id, body.tokenId));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/file-tokens/delete')),
);

app.post(
	'/create-by-passphrase',
	describeRoute(omitResAndReq(apiDef['/api/file-tokens/create-by-passphrase'])),
	validator('json', apiDef['/api/file-tokens/create-by-passphrase'].req),
	describeResponse(async (c: JsonCtx<'/api/file-tokens/create-by-passphrase', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');

		const turnstileSecret = c.env.TURNSTILE_SECRET as string;
		if (turnstileSecret !== '') {
			if (!body.turnstileToken) {
				throw new HTTPException(400, { message: 'turnstileToken is required' });
			}
			const ok = await verifyTurnstile(body.turnstileToken, turnstileSecret);
			if (!ok) {
				throw new HTTPException(400, { message: 'Turnstile verification failed' });
			}
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.name, body.bucketName)).get();
		if (!bucket) throw new HTTPException(404, { message: 'Bucket not found' });

		const file = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, bucket.id), eq(files.path, body.filePath)))
			.get();
		if (!file) throw new HTTPException(404, { message: 'File not found' });
		if (!file.isClosed) throw new HTTPException(400, { message: 'File is not closed' });
		if (file.isPublic) throw new HTTPException(400, { message: 'File is public' });
		if (file.passphrase === null) throw new HTTPException(403, { message: 'No passphrase set for this file' });
		if (body.passphrase !== file.passphrase) throw new HTTPException(403, { message: 'Invalid passphrase' });

		const id = genEaidx(Date.now());
		const token = generateToken();
		const expiresAt = Date.now() + 3600 * 1000;

		await db.insert(fileAccessTokens).values({ id, fileId: file.id, token, expiresAt });

		return c.json({ id, token, expiresAt }, 200);
	}, apiDef['/api/file-tokens/create-by-passphrase'].res),
);

export { app as fileTokenRoutes };
