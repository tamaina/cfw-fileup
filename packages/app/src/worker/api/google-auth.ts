import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, count, lt } from 'drizzle-orm';
import { users, tokens, appSettings, oauthStates } from '../scheme/index';
import { getDb } from '../utils/db';
import { generateToken } from '../utils/crypto';
import { genEaidx } from '../../shared/eaid-x';
import { googleAuthApiSchema } from './google-auth.definition';
import type { ExtractResponseType } from './schema-type';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface GoogleUserInfo {
	sub: string;
	email?: string;
	name?: string;
	picture?: string;
}

interface GoogleTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	id_token?: string;
}

function getRedirectUri(env: Env, url: URL): string {
	if ((env.GOOGLE_REDIRECT_URI as string) !== '') {
		return env.GOOGLE_REDIRECT_URI;
	}
	return `${url.protocol}//${url.host}/api/auth/google/callback`;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', async (c) => {
	if ((c.env.GOOGLE_CLIENT_ID as string) === '' || (c.env.GOOGLE_CLIENT_SECRET as string) === '') {
		throw new HTTPException(503, { message: 'Google OAuth is not configured' });
	}

	const db = getDb(c.env);

	// Clean up expired states
	await db.delete(oauthStates).where(lt(oauthStates.expiresAt, Date.now()));

	const state = generateToken();
	const stateId = genEaidx(Date.now());
	const expiresAt = Date.now() + STATE_TTL_MS;

	await db.insert(oauthStates).values({ id: stateId, state, expiresAt });

	const url = new URL(c.req.url);
	const redirectUri = getRedirectUri(c.env, url);

	const authUrl = new URL(GOOGLE_AUTH_URL);
	authUrl.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID);
	authUrl.searchParams.set('redirect_uri', redirectUri);
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('scope', 'openid email profile');
	authUrl.searchParams.set('state', state);
	authUrl.searchParams.set('access_type', 'online');

	return c.redirect(authUrl.toString(), 302);
});

app.get('/callback', async (c) => {
	if ((c.env.GOOGLE_CLIENT_ID as string) === '' || (c.env.GOOGLE_CLIENT_SECRET as string) === '') {
		throw new HTTPException(503, { message: 'Google OAuth is not configured' });
	}

	const db = getDb(c.env);
	const { code, state, error } = c.req.query();

	if (error) {
		throw new HTTPException(400, { message: `Google OAuth error: ${error}` });
	}

	if (!code || !state) {
		throw new HTTPException(400, { message: 'Missing code or state parameter' });
	}

	// Validate state (CSRF protection)
	const storedState = await db
		.select()
		.from(oauthStates)
		.where(eq(oauthStates.state, state))
		.get();

	if (!storedState || storedState.expiresAt < Date.now()) {
		throw new HTTPException(400, { message: 'Invalid or expired state parameter' });
	}

	// Delete the used state
	await db.delete(oauthStates).where(eq(oauthStates.id, storedState.id));

	// Exchange code for tokens
	const url = new URL(c.req.url);
	const redirectUri = getRedirectUri(c.env, url);

	const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: c.env.GOOGLE_CLIENT_ID,
			client_secret: c.env.GOOGLE_CLIENT_SECRET,
			redirect_uri: redirectUri,
			grant_type: 'authorization_code',
		}),
	});

	if (!tokenRes.ok) {
		const body = await tokenRes.text();
		console.error('Google token exchange failed:', body);
		throw new HTTPException(502, { message: 'Failed to exchange code for token' });
	}

	const tokenData = (await tokenRes.json()) as GoogleTokenResponse;

	// Fetch user info
	const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
		headers: { Authorization: `Bearer ${tokenData.access_token}` },
	});

	if (!userinfoRes.ok) {
		throw new HTTPException(502, { message: 'Failed to fetch Google user info' });
	}

	const userInfo = (await userinfoRes.json()) as GoogleUserInfo;
	const googleId = userInfo.sub;

	if (!googleId) {
		throw new HTTPException(502, { message: 'Invalid Google user info: missing sub' });
	}

	// Check if user exists with this Google ID
	let user = await db.select().from(users).where(eq(users.googleId, googleId)).get();

	if (user) {
		// Existing Google user - sign in
		if (user.isSuspended) {
			throw new HTTPException(401, { message: 'Account is suspended' });
		}
	} else {
		// New Google user - check if registration is allowed
		const userCount = await db.select({ count: count() }).from(users);
		const isFirstUser = (userCount[0]?.count ?? 0) === 0;

		if (!isFirstUser) {
			const registrationEnabled = await db
				.select()
				.from(appSettings)
				.where(eq(appSettings.key, 'registration_enabled'))
				.get();

			if (registrationEnabled?.value === 'false') {
				throw new HTTPException(403, { message: 'Registration is closed' });
			}
		}

		// Generate a username from Google profile
		const nameSource = userInfo.name ?? (userInfo.email ? userInfo.email.split('@')[0] : undefined) ?? 'user';
		const baseUsername = nameSource.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 28);

		let username = baseUsername;
		let suffix = 1;
		while (await db.select().from(users).where(eq(users.username, username)).get()) {
			username = `${baseUsername}_${suffix}`;
			suffix++;
		}

		const userId = genEaidx(Date.now());
		await db.insert(users).values({
			id: userId,
			username,
			passwordHash: null,
			googleId,
			isAdmin: isFirstUser,
			isSuspended: false,
		});

		if (isFirstUser) {
			await db
				.insert(appSettings)
				.values({ key: 'registration_enabled', value: 'true' })
				.onConflictDoNothing();
		}

		user = await db.select().from(users).where(eq(users.id, userId)).get();
		if (!user) {
			throw new HTTPException(500, { message: 'Failed to create user' });
		}
	}

	// Issue session token
	const tokenId = genEaidx(Date.now());
	const tokenValue = generateToken();

	await db.insert(tokens).values({
		id: tokenId,
		userId: user.id,
		token: tokenValue,
	});

	// Redirect to frontend signin page with token as query parameter
	return c.redirect(`/signin?google_token=${encodeURIComponent(tokenValue)}`, 302);
});

// API endpoint to complete Google sign-in from the frontend (exchange token)
app.post('/complete', async (c) => {
	type CompleteReq = ExtractResponseType<typeof googleAuthApiSchema, '/api/auth/google/complete', 'post', 200>;
	const body = (await c.req.json()) as { googleToken?: string };

	if (!body.googleToken) {
		throw new HTTPException(400, { message: 'googleToken is required' });
	}

	const db = getDb(c.env);

	const tokenRecord = await db.select().from(tokens).where(eq(tokens.token, body.googleToken)).get();
	if (!tokenRecord) {
		throw new HTTPException(401, { message: 'Invalid token' });
	}

	// Token is valid - return it as the session token
	return c.json({ token: body.googleToken } as CompleteReq);
});

export const googleAuthRoutes = app;
