import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { tokens, users } from '../scheme/index';
import { getDb } from '../utils/db';
import { apiError } from '../utils/api-error';

export type AuthUser = {
	id: string;
	username: string;
	isAdmin: boolean;
	isSuspended: boolean;
	termsAgreedAt: number | null;
	reauthenticatedAt: number | null;
};

declare module 'hono' {
	interface ContextVariableMap {
		user: AuthUser;
	}
}

export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	const authorization = c.req.header('Authorization');
	if (!authorization?.startsWith('Bearer ')) {
		throw apiError(401, 'UNAUTHORIZED');
	}

	const token = authorization.slice(7);
	const db = getDb(c.env);

	const tokenRecord = await db
		.select({
			userId: tokens.userId,
			username: users.username,
			isAdmin: users.isAdmin,
			isSuspended: users.isSuspended,
			termsAgreedAt: users.termsAgreedAt,
			reauthenticatedAt: tokens.reauthenticatedAt,
		})
		.from(tokens)
		.innerJoin(users, eq(tokens.userId, users.id))
		.where(eq(tokens.token, token))
		.get();

	if (!tokenRecord) {
		throw apiError(401, 'UNAUTHORIZED');
	}

	if (tokenRecord.isSuspended) {
		throw apiError(403, 'ACCOUNT_IS_SUSPENDED');
	}

	c.set('user', {
		id: tokenRecord.userId,
		username: tokenRecord.username,
		isAdmin: tokenRecord.isAdmin,
		isSuspended: tokenRecord.isSuspended,
		termsAgreedAt: tokenRecord.termsAgreedAt,
		reauthenticatedAt: tokenRecord.reauthenticatedAt,
	});

	await next();
});

export const adminMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
	const user = c.get('user');
	if (!user.isAdmin) {
		throw apiError(403, 'FORBIDDEN');
	}
	await next();
});
