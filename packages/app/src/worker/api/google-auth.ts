import { Hono } from 'hono';
import { describeResponse, validator } from 'hono-openapi';
import { eq, count, lt } from 'drizzle-orm';
import { apiError } from '../utils/api-error';
import { users, tokens, appSettings, oauthStates, usedUsernames } from '../scheme/index';
import { getDb } from '../utils/db';
import { generateToken } from '../utils/crypto';
import { genEaidx } from '../../shared/eaid-x';
import { validateUsername } from '../utils/name-validation';
import { isValidNameFormat } from '../../shared/name-validation';
import { MAX_ID_LENGTH, MAX_PASSPHRASE_LENGTH, MAX_USERNAME_LENGTH } from '../../shared/const';
import { apiDef, type JsonCtx } from '../../shared/api';

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

export function getGoogleRedirectUri(env: Env, url: URL): string {
	if ((env.GOOGLE_REDIRECT_URI as string) !== '') {
		return env.GOOGLE_REDIRECT_URI;
	}
	return `${url.protocol}//${url.host}/api/auth/google/callback`;
}

function googleErrorLocation(error: string, path: '/signin' | '/signup' = '/signin'): string {
	return `${path}?google_error=${encodeURIComponent(error)}`;
}

const app = new Hono<{ Bindings: Env }>();

export async function createGoogleAuthUrl(env: Env, requestUrl: URL, linkUserId?: string, signupPassphrase?: string, signupUsername?: string): Promise<string> {
	if ((env.GOOGLE_CLIENT_ID as string) === '' || (env.GOOGLE_CLIENT_SECRET as string) === '') {
		throw apiError(503, 'GOOGLE_OAUTH_IS_NOT_CONFIGURED');
	}

	const db = getDb(env);
	await db.delete(oauthStates).where(lt(oauthStates.expiresAt, Date.now()));

	const state = generateToken();
	const stateId = genEaidx(Date.now());
	const expiresAt = Date.now() + STATE_TTL_MS;

	await db.insert(oauthStates).values({ id: stateId, state, linkUserId, signupPassphrase, signupUsername, expiresAt });

	const redirectUri = getGoogleRedirectUri(env, requestUrl);
	const authUrl = new URL(GOOGLE_AUTH_URL);
	authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
	authUrl.searchParams.set('redirect_uri', redirectUri);
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('scope', 'openid email profile');
	authUrl.searchParams.set('state', state);
	authUrl.searchParams.set('access_type', 'online');

	return authUrl.toString();
}

app.get('/', async (c) => {
	const passphrase = c.req.query('passphrase');
	const signupUsername = c.req.query('username');
	if (passphrase || signupUsername) {
		throw apiError(400, 'USE_POST_FOR_OAUTH_SIGNUP');
	}
	if (passphrase && passphrase.length > MAX_PASSPHRASE_LENGTH) {
		throw apiError(400, 'PASSPHRASE_TOO_LONG', `passphrase must be at most ${MAX_PASSPHRASE_LENGTH} characters`);
	}
	if (signupUsername && signupUsername.length > MAX_USERNAME_LENGTH) {
		throw apiError(400, 'INVALID_USERNAME_FORMAT', `username must be at most ${MAX_USERNAME_LENGTH} characters`);
	}

	const url = new URL(c.req.url);
	return c.redirect(await createGoogleAuthUrl(c.env, url, undefined, passphrase, signupUsername), 302);
});

app.post(
	'/begin',
	validator('json', apiDef['/api/auth/google/begin'].req),
	describeResponse(async (c: JsonCtx<'/api/auth/google/begin', Env>) => {
		const body = c.req.valid('json');
		const url = new URL(c.req.url);
		return c.json({
			url: await createGoogleAuthUrl(c.env, url, undefined, body.passphrase, body.username),
		}, 200);
	}, apiDef['/api/auth/google/begin'].res),
);

app.get('/callback', async (c) => {
	if ((c.env.GOOGLE_CLIENT_ID as string) === '' || (c.env.GOOGLE_CLIENT_SECRET as string) === '') {
		throw apiError(503, 'GOOGLE_OAUTH_IS_NOT_CONFIGURED');
	}

	const db = getDb(c.env);
	const { code, state, error } = c.req.query();

	if (error) {
		return c.redirect(googleErrorLocation(error), 302);
	}

	if (!code || !state) {
		return c.redirect(googleErrorLocation('missing_params'), 302);
	}
	if (state.length > MAX_ID_LENGTH) {
		return c.redirect(googleErrorLocation('invalid_state'), 302);
	}

	// Validate state (CSRF protection)
	const storedState = await db
		.select()
		.from(oauthStates)
		.where(eq(oauthStates.state, state))
		.get();

	if (!storedState || storedState.expiresAt < Date.now()) {
		return c.redirect(googleErrorLocation('invalid_state'), 302);
	}

	// Delete the used state
	await db.delete(oauthStates).where(eq(oauthStates.id, storedState.id));

	// Exchange code for tokens
	const url = new URL(c.req.url);
	const redirectUri = getGoogleRedirectUri(c.env, url);

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
		return c.redirect(googleErrorLocation('token_exchange_failed'), 302);
	}

	const tokenData = (await tokenRes.json()) as GoogleTokenResponse;

	// Fetch user info
	const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
		headers: { Authorization: `Bearer ${tokenData.access_token}` },
	});

	if (!userinfoRes.ok) {
		return c.redirect(googleErrorLocation('userinfo_failed'), 302);
	}

	const userInfo = (await userinfoRes.json()) as GoogleUserInfo;
	const googleId = userInfo.sub;

	if (!googleId) {
		return c.redirect(googleErrorLocation('userinfo_failed'), 302);
	}

	const linkedUser = await db.select().from(users).where(eq(users.googleId, googleId)).get();

	if (storedState.linkUserId) {
		if (linkedUser && linkedUser.id !== storedState.linkUserId) {
			return c.redirect('/my/account?link_error=account_already_linked', 302);
		}

		const currentUser = await db.select().from(users).where(eq(users.id, storedState.linkUserId)).get();
		if (!currentUser || currentUser.isSuspended) {
			return c.redirect('/my/account?link_error=link_failed', 302);
		}
		if (currentUser.googleId && currentUser.googleId !== googleId) {
			return c.redirect('/my/account?link_error=already_linked', 302);
		}

		await db.update(users).set({ googleId }).where(eq(users.id, storedState.linkUserId));
		return c.redirect('/my/account?link_success=google', 302);
	}

	// Check if user exists with this Google ID
	let user = linkedUser;

	if (user) {
		// Existing Google user - sign in
		if (user.isSuspended) {
			return c.redirect(googleErrorLocation('suspended'), 302);
		}
	} else {
		// New Google user - check if registration is allowed
		const userCount = await db.select({ count: count() }).from(users);
		const isFirstUser = (userCount[0]?.count ?? 0) === 0;

		const registrationModeSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'registration_mode'))
			.get();

		const registrationMode = (registrationModeSetting?.value ?? 'passphrase') as 'closed' | 'passphrase' | 'open';

		if (!isFirstUser) {
			if (registrationMode === 'closed') {
				return c.redirect(googleErrorLocation('registration_closed', '/signup'), 302);
			}
		}

		if (registrationMode === 'passphrase') {
			const signupPassphrase = c.env.SIGNUP_PASSPHRASE;
			if (!signupPassphrase || !storedState.signupPassphrase || storedState.signupPassphrase !== signupPassphrase) {
				return c.redirect(googleErrorLocation('signup_required', '/signup'), 302);
			}
		}

		const username = storedState.signupUsername?.trim();
		if (!username) {
			return c.redirect(googleErrorLocation('signup_required', '/signup'), 302);
		}

		if (!isValidNameFormat(username)) {
			return c.redirect(googleErrorLocation('invalid_username', '/signup'), 302);
		}

		if (!isFirstUser) {
			const usernameError = await validateUsername(db, username);
			if (usernameError) {
				const error = usernameError === 'Username already exists' ? 'username_taken' : 'invalid_username';
				return c.redirect(googleErrorLocation(error, '/signup'), 302);
			}
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

		await db
			.insert(usedUsernames)
			.values({ username: username.toLowerCase() })
			.onConflictDoNothing();

		user = await db.select().from(users).where(eq(users.id, userId)).get();
		if (!user) {
			return c.redirect(googleErrorLocation('user_creation_failed', '/signup'), 302);
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
	const body = (await c.req.json()) as { googleToken?: string };

	if (!body.googleToken) {
		throw apiError(400, 'GOOGLE_TOKEN_IS_REQUIRED');
	}

	const db = getDb(c.env);

	const tokenRecord = await db.select().from(tokens).where(eq(tokens.token, body.googleToken)).get();
	if (!tokenRecord) {
		throw apiError(401, 'INVALID_TOKEN');
	}

	// Token is valid - return it as the session token
	return c.json({ token: body.googleToken });
});

export const googleAuthRoutes = app;
