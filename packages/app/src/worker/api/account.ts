import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { users } from '../scheme/index';
import { getDb } from '../utils/db';
import { authMiddleware } from '../middleware/auth';
import { hashPassword, verifyPassword } from '../utils/crypto';
import type { Schema, SchemaType } from './schema-type';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const updateAccountSchema = {
	type: 'object',
	properties: {
		username: { type: 'string', minLength: 1, maxLength: 32, optional: true },
		newPassword: { type: 'string', minLength: 8, optional: true },
		currentPassword: { type: 'string' },
	},
	required: ['currentPassword'],
} as const satisfies Schema;

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

app.get('/me', (c) => {
	const user = c.get('user');
	return c.json({
		id: user.id,
		username: user.username,
		isAdmin: user.isAdmin,
	});
});

app.post('/update', async (c) => {
	const db = getDb(c.env);
	const user = c.get('user');
	const body = (await c.req.json()) as SchemaType<typeof updateAccountSchema>;

	if (!body.currentPassword) {
		throw new HTTPException(400, { message: 'currentPassword is required' });
	}

	const userRecord = await db.select().from(users).where(eq(users.id, user.id)).get();

	if (!userRecord) {
		throw new HTTPException(404, { message: 'User not found' });
	}

	if (!userRecord.passwordHash) {
		throw new HTTPException(400, { message: 'This account uses Google sign-in and cannot change password this way' });
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
