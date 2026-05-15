import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, count } from 'drizzle-orm';
import { users, tokens, appSettings } from '../scheme/index';
import { getDb } from '../utils/db';
import { hashPassword, verifyPassword, generateToken } from '../utils/crypto';
import { genEaidx } from '../../shared/eaid-x';
import type { SchemaType, ExtractRequestType, ExtractResponseType } from './schema-type';
import { authApiSchema } from './auth.definition';

const app = new Hono<{ Bindings: Env }>();

app.post('/signup', async (c) => {
	const db = getDb(c.env);
	type SignupReq = ExtractRequestType<typeof authApiSchema, '/api/signup', 'post'>;
	const body = (await c.req.json()) as SignupReq;

	if (!body.username || !body.password) {
		throw new HTTPException(400, { message: 'username and password are required' });
	}

	if (body.username.length < 1 || body.username.length > 32) {
		throw new HTTPException(400, { message: 'username must be 1-32 characters' });
	}

	if (body.password.length < 8) {
		throw new HTTPException(400, { message: 'password must be at least 8 characters' });
	}

	const userCount = await db.select({ count: count() }).from(users);
	const isFirstUser = (userCount[0]?.count ?? 0) === 0;

	// Get or initialize require_signup_passphrase setting
	let requireSignupPassphraseSetting = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.key, 'require_signup_passphrase'))
		.get();

	if (!requireSignupPassphraseSetting) {
		const defaultValue = c.env.SIGNUP_PASSPHRASE ? 'true' : 'false';
		await db.insert(appSettings).values({
			key: 'require_signup_passphrase',
			value: defaultValue,
		});
		requireSignupPassphraseSetting = { key: 'require_signup_passphrase', value: defaultValue };
	}

	// Check passphrase requirement (first user is always exempt)
	const requireSignupPassphrase = requireSignupPassphraseSetting?.value === 'true';
	const signupPassphrase = c.env.SIGNUP_PASSPHRASE;

	if (requireSignupPassphrase && !isFirstUser) {
		if (!signupPassphrase || !body.passphrase || body.passphrase !== signupPassphrase) {
			throw new HTTPException(403, { message: 'Invalid passphrase' });
		}
	}

	const existingUser = await db.select().from(users).where(eq(users.username, body.username)).get();
	if (existingUser) {
		throw new HTTPException(409, { message: 'Username already exists' });
	}

	const registrationEnabled = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.key, 'registration_enabled'))
		.get();

	if (!isFirstUser && registrationEnabled?.value === 'false') {
		throw new HTTPException(403, { message: 'Registration is closed' });
	}

	const userId = genEaidx(Date.now());
	const passwordHash = await hashPassword(body.password);

	await db.insert(users).values({
		id: userId,
		username: body.username,
		passwordHash,
		isAdmin: isFirstUser,
		isSuspended: false,
	});

	const tokenId = genEaidx(Date.now());
	const tokenValue = generateToken();

	await db.insert(tokens).values({
		id: tokenId,
		userId,
		token: tokenValue,
	});

	if (isFirstUser) {
		await db
			.insert(appSettings)
			.values({
				key: 'registration_enabled',
				value: 'true',
			})
			.onConflictDoNothing();
	}

	return c.json({ userId, token: tokenValue });
});

app.post('/signin', async (c) => {
	const db = getDb(c.env);
	type SigninReq = ExtractRequestType<typeof authApiSchema, '/api/signin', 'post'>;
	const body = (await c.req.json()) as SigninReq;

	if (!body.username || !body.password) {
		throw new HTTPException(400, { message: 'username and password are required' });
	}

	const user = await db.select().from(users).where(eq(users.username, body.username)).get();

	if (!user) {
		throw new HTTPException(401, { message: 'Invalid credentials' });
	}

	if (user.isSuspended) {
		throw new HTTPException(401, { message: 'Account is suspended' });
	}

	const passwordValid = await verifyPassword(body.password, user.passwordHash);
	if (!passwordValid) {
		throw new HTTPException(401, { message: 'Invalid credentials' });
	}

	const tokenId = genEaidx(Date.now());
	const tokenValue = generateToken();

	await db.insert(tokens).values({
		id: tokenId,
		userId: user.id,
		token: tokenValue,
	});

	return c.json({ token: tokenValue });
});

app.get('/account/me', async (c) => {
	const user = c.get('user');
	return c.json({
		id: user.id,
		username: user.username,
		isAdmin: user.isAdmin,
		isSuspended: user.isSuspended,
	});
});

export default app;
