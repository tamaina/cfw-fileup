import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq } from 'drizzle-orm';
import { users, usedUsernames } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { validateUsername } from '../utils/name-validation';
import { apiDef, getResponseDefWithAuth } from '../../shared/api';
import type { JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

app.post(
  '/me',
  describeRoute(omitResAndReq(apiDef['/api/account/me'])),
  validator('json', apiDef['/api/account/me'].req),
  describeResponse(async (c) => {
    const user = c.get('user');
    return c.json({
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
    }, 200);
  }, getResponseDefWithAuth('/api/account/me'))
);

app.post(
	'/update',
	describeRoute(omitResAndReq(apiDef['/api/account/update'])),
	validator('json', apiDef['/api/account/update'].req),
	describeResponse(async (c: JsonCtx<'/api/account/update', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.currentPassword) {
			throw new HTTPException(400, { message: 'currentPassword is required' });
		}

		const userRecord = await db.select().from(users).where(eq(users.id, user.id)).get();

		if (!userRecord) {
			throw new HTTPException(404, { message: 'User not found' });
		}

		const passwordValid = await verifyPassword(body.currentPassword, userRecord.passwordHash);
		if (!passwordValid) {
			throw new HTTPException(401, { message: 'Invalid password' });
		}

		if (body.username) {
			const newUsername = body.username.trim();

			if (newUsername.length < 1 || newUsername.length > 32) {
				throw new HTTPException(400, { message: 'username must be 1-32 characters' });
			}

			if (newUsername.toLowerCase() !== userRecord.username.toLowerCase()) {
				// 文字種・禁止ワード・重複（大文字小文字を区別しない）チェック
				const usernameError = await validateUsername(db, newUsername);
				if (usernameError) {
					const status = usernameError === 'Username already exists' ? 409 : 400;
					throw new HTTPException(status, { message: usernameError });
				}

				await db.update(users).set({ username: newUsername }).where(eq(users.id, user.id));

				// lowercaseで used_usernames に登録（削除後も同名再利用不可）
				await db
					.insert(usedUsernames)
					.values({ username: newUsername.toLowerCase() })
					.onConflictDoNothing();
			}
		}

		if (body.newPassword) {
			if (body.newPassword.length < 8) {
				throw new HTTPException(400, { message: 'password must be at least 8 characters' });
			}

			const passwordHash = await hashPassword(body.newPassword);
			await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
		}

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/account/update')),
);

export const accountRoutes = app;
