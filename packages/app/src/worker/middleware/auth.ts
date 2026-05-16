import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { tokens, users } from '../scheme/index';
import { getDb } from '../utils/db';

export type AuthUser = {
	id: string;
	username: string;
	isAdmin: boolean;
	isSuspended: boolean;
};

declare module 'hono' {
	interface ContextVariableMap {
		user: AuthUser;
	}
}

export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	const authorization = c.req.header('Authorization');
	if (!authorization?.startsWith('Bearer ')) {
		throw new HTTPException(401, { message: 'Unauthorized' });
	}

	const token = authorization.slice(7);
	const db = getDb(c.env);

	const tokenRecord = await db
		.select({
			userId: tokens.userId,
			username: users.username,
			isAdmin: users.isAdmin,
			isSuspended: users.isSuspended,
		})
		.from(tokens)
		.innerJoin(users, eq(tokens.userId, users.id))
		.where(eq(tokens.token, token))
		.get();

	if (!tokenRecord) {
		throw new HTTPException(401, { message: 'Unauthorized' });
	}

	if (tokenRecord.isSuspended) {
		throw new HTTPException(403, { message: 'Account is suspended' });
	}

	c.set('user', {
		id: tokenRecord.userId,
		username: tokenRecord.username,
		isAdmin: tokenRecord.isAdmin,
		isSuspended: tokenRecord.isSuspended,
	});

	await next();
});

export const adminMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	const user = c.get('user');
	if (!user.isAdmin) {
		throw new HTTPException(403, { message: 'Forbidden' });
	}
	await next();
});
