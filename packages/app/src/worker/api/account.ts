import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono-openapi';
import { eq } from 'drizzle-orm';
import { users } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { UpdateAccountBody } from '../../shared/api/account';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

app.post('/me', (c) => {
	const user = c.get('user');
	return c.json({
		id: user.id,
		username: user.username,
		isAdmin: user.isAdmin,
	});
});

app.post('/update', validator('json', UpdateAccountBody), async (c) => {
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
		if (body.username.length < 1 || body.username.length > 32) {
			throw new HTTPException(400, { message: 'username must be 1-32 characters' });
		}

		const existingUser = await db
			.select()
			.from(users)
			.where(eq(users.username, body.username))
			.get();

		if (existingUser && existingUser.id !== user.id) {
			throw new HTTPException(409, { message: 'Username already exists' });
		}

		await db.update(users).set({ username: body.username }).where(eq(users.id, user.id));
	}

	if (body.newPassword) {
		if (body.newPassword.length < 8) {
			throw new HTTPException(400, { message: 'password must be at least 8 characters' });
		}

		const passwordHash = await hashPassword(body.newPassword);
		await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
	}

	return c.json({ ok: true });
});

export const accountRoutes = app;
