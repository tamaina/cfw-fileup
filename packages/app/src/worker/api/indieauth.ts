import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, count, lt } from 'drizzle-orm';
import { users, tokens, appSettings, oauthStates, usedUsernames } from '../scheme/index';
import { getDb } from '../utils/db';
import { generateToken } from '../utils/crypto';
import { genEaidx } from '../../shared/eaid-x';
import { validateUsername } from '../utils/name-validation';
import { isValidNameFormat } from '../../shared/name-validation';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MISSKEY_OAUTH_SCOPE = 'read:account';

interface OAuthAuthorizationServerMetadata {
	issuer?: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	code_challenge_methods_supported?: string[];
}

interface OAuthDiscoveryResult {
	authorizationEndpoint: string;
	tokenEndpoint: string | null;
	issuer: string;
}

interface MisskeyTokenResponse {
	access_token?: string;
	token_type?: string;
	scope?: string;
	me?: string;
	profile?: { name?: string; url?: string };
}

interface MisskeyAccount {
	id?: string;
	username?: string;
	name?: string | null;
}

/**
 * Generate a PKCE code_verifier (43-128 chars, URL-safe base64url without padding)
 */
function generateCodeVerifier(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
}

/**
 * Generate PKCE code_challenge from code_verifier using S256 method
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
}

function getOrigin(urlString: string): string | null {
	try {
		return new URL(urlString).origin;
	} catch {
		return null;
	}
}

async function discoverOAuthMetadata(profileUrl: string): Promise<OAuthDiscoveryResult | null> {
	const origin = getOrigin(profileUrl);
	if (!origin) return null;

	let res: Response;
	try {
		res = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
			headers: { Accept: 'application/json' },
		});
	} catch {
		return null;
	}

	if (!res.ok) return null;

	let metadata: OAuthAuthorizationServerMetadata;
	try {
		metadata = await res.json() as OAuthAuthorizationServerMetadata;
	} catch {
		return null;
	}

	if (!metadata.authorization_endpoint || !metadata.token_endpoint) return null;

	return {
		authorizationEndpoint: new URL(metadata.authorization_endpoint, origin).toString(),
		tokenEndpoint: new URL(metadata.token_endpoint, origin).toString(),
		issuer: metadata.issuer ?? origin,
	};
}

/**
 * Discover IndieAuth/OAuth authorization endpoint from a profile URL.
 * Misskey exposes OAuth Authorization Server Metadata; older IndieAuth-style
 * pages may expose rel=authorization_endpoint and rel=token_endpoint.
 */
async function discoverAuthorizationServer(profileUrl: string): Promise<OAuthDiscoveryResult | null> {
	const metadata = await discoverOAuthMetadata(profileUrl);
	if (metadata) return metadata;

	let res: Response;
	try {
		res = await fetch(profileUrl, {
			headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
			redirect: 'follow',
		});
	} catch {
		return null;
	}

	if (!res.ok) return null;

	let authorizationEndpoint: string | null = null;
	let tokenEndpoint: string | null = null;

	// Check Link header first (RFC 5988)
	const linkHeader = res.headers.get('Link');
	if (linkHeader) {
		const authMatch = linkHeader.match(/<([^>]+)>\s*;\s*rel="authorization_endpoint"/i)
			?? linkHeader.match(/<([^>]+)>\s*;\s*rel=authorization_endpoint/i);
		if (authMatch?.[1]) {
			authorizationEndpoint = new URL(authMatch[1], profileUrl).toString();
		}

		const tokenMatch = linkHeader.match(/<([^>]+)>\s*;\s*rel="token_endpoint"/i)
			?? linkHeader.match(/<([^>]+)>\s*;\s*rel=token_endpoint/i);
		if (tokenMatch?.[1]) {
			tokenEndpoint = new URL(tokenMatch[1], profileUrl).toString();
		}
	}

	// Parse HTML for rel=authorization_endpoint and rel=token_endpoint.
	const html = await res.text();
	const linkTagPattern = /<link[^>]+>/gi;
	let linkMatch: RegExpExecArray | null;
	while ((linkMatch = linkTagPattern.exec(html)) !== null) {
		const tag = linkMatch[0];
		if (/rel=["']?authorization_endpoint["']?/i.test(tag)) {
			const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
			if (hrefMatch?.[1]) {
				authorizationEndpoint = new URL(hrefMatch[1], profileUrl).toString();
			}
		}
		if (/rel=["']?token_endpoint["']?/i.test(tag)) {
			const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
			if (hrefMatch?.[1]) {
				tokenEndpoint = new URL(hrefMatch[1], profileUrl).toString();
			}
		}
	}

	if (!authorizationEndpoint) return null;

	return {
		authorizationEndpoint,
		tokenEndpoint,
		issuer: getOrigin(profileUrl) ?? profileUrl,
	};
}

/**
 * Normalize and validate a profile URL.
 * Returns the canonical profile URL, or null if invalid.
 */
function normalizeProfileUrl(input: string): string | null {
	let url: URL;
	try {
		// Try parsing as-is; if no protocol, try adding https://
		if (!input.startsWith('http://') && !input.startsWith('https://')) {
			if (input.includes('://') || !input.includes('.')) return null;
			url = new URL(`https://${input}`);
		} else {
			url = new URL(input);
		}
	} catch {
		return null;
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (!url.hostname) return null;

	return url.toString();
}

/**
 * Extract the server hostname from a profile URL.
 */
function getServerHost(profileUrl: string): string {
	try {
		return new URL(profileUrl).hostname;
	} catch {
		return '';
	}
}

/**
 * Check if the server of a profile URL is blocked by admin settings.
 */
async function isServerBlocked(env: Env, profileUrl: string): Promise<boolean> {
	const db = getDb(env);
	const host = getServerHost(profileUrl);
	if (!host) return true;

	const blockedSetting = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.key, 'indieauth_blocked_servers'))
		.get();

	if (!blockedSetting?.value) return false;

	const blockedHosts = blockedSetting.value
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);

	return blockedHosts.includes(host.toLowerCase());
}

function getCallbackUri(requestUrl: URL): string {
	return `${requestUrl.protocol}//${requestUrl.host}/api/auth/indieauth/callback`;
}

function getClientId(requestUrl: URL): string {
	return `${requestUrl.protocol}//${requestUrl.host}/api/auth/indieauth/client`;
}

async function fetchMisskeyAccount(issuer: string, accessToken: string): Promise<MisskeyAccount | null> {
	let res: Response;
	try {
		res = await fetch(`${issuer}/api/i`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ i: accessToken }),
		});
	} catch {
		return null;
	}

	if (!res.ok) return null;

	try {
		return await res.json() as MisskeyAccount;
	} catch {
		return null;
	}
}

const app = new Hono<{ Bindings: Env }>();

app.get('/client', (c) => {
	const requestUrl = new URL(c.req.url);
	const callbackUri = getCallbackUri(requestUrl);

	return c.html(`<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>CFW FileUp</title>
		<link rel="redirect_uri" href="${callbackUri}">
	</head>
	<body>
		<div class="h-app">
			<a class="u-url p-name" href="${requestUrl.protocol}//${requestUrl.host}/">CFW FileUp</a>
		</div>
	</body>
</html>`);
});

app.get('/begin', async (c) => {
	const profileUrlRaw = c.req.query('profile_url');
	const passphrase = c.req.query('passphrase');
	const signupUsername = c.req.query('username');
	if (!profileUrlRaw) {
		throw new HTTPException(400, { message: 'profile_url is required' });
	}

	const profileUrl = normalizeProfileUrl(profileUrlRaw);
	if (!profileUrl) {
		throw new HTTPException(400, { message: 'Invalid profile URL' });
	}

	if (await isServerBlocked(c.env, profileUrl)) {
		throw new HTTPException(403, { message: 'This Misskey server is not allowed' });
	}

	const server = await discoverAuthorizationServer(profileUrl);
	if (!server) {
		throw new HTTPException(400, { message: 'Could not discover IndieAuth authorization endpoint from the given profile URL' });
	}

	const db = getDb(c.env);

	// Clean up expired states
	await db.delete(oauthStates).where(lt(oauthStates.expiresAt, Date.now()));

	const state = generateToken();
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = await generateCodeChallenge(codeVerifier);
	const stateId = genEaidx(Date.now());
	const expiresAt = Date.now() + STATE_TTL_MS;

	await db.insert(oauthStates).values({
		id: stateId,
		state,
		codeVerifier,
		profileUrl,
		signupPassphrase: passphrase,
		signupUsername,
		expiresAt,
	});

	const requestUrl = new URL(c.req.url);
	const redirectUri = getCallbackUri(requestUrl);
	const clientId = getClientId(requestUrl);

	const authUrl = new URL(server.authorizationEndpoint);
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('client_id', clientId);
	authUrl.searchParams.set('redirect_uri', redirectUri);
	authUrl.searchParams.set('state', state);
	authUrl.searchParams.set('code_challenge', codeChallenge);
	authUrl.searchParams.set('code_challenge_method', 'S256');
	authUrl.searchParams.set('scope', MISSKEY_OAUTH_SCOPE);

	return c.redirect(authUrl.toString(), 302);
});

app.get('/callback', async (c) => {
	const db = getDb(c.env);
	const { code, state, error } = c.req.query();

	if (error) {
		return c.redirect(`/signin?indieauth_error=${encodeURIComponent(error)}`, 302);
	}

	if (!code || !state) {
		return c.redirect('/signin?indieauth_error=missing_params', 302);
	}

	// Validate state (CSRF protection)
	const storedState = await db
		.select()
		.from(oauthStates)
		.where(eq(oauthStates.state, state))
		.get();

	if (!storedState || storedState.expiresAt < Date.now()) {
		return c.redirect('/signin?indieauth_error=invalid_state', 302);
	}

	const { codeVerifier, profileUrl } = storedState;

	if (!codeVerifier || !profileUrl) {
		await db.delete(oauthStates).where(eq(oauthStates.id, storedState.id));
		return c.redirect('/signin?indieauth_error=missing_verifier', 302);
	}

	// Delete the used state
	await db.delete(oauthStates).where(eq(oauthStates.id, storedState.id));

	// Re-check if server is blocked (in case settings changed)
	if (await isServerBlocked(c.env, profileUrl)) {
		return c.redirect('/signin?indieauth_error=server_blocked', 302);
	}

	const server = await discoverAuthorizationServer(profileUrl);
	if (!server) {
		return c.redirect('/signin?indieauth_error=discovery_failed', 302);
	}

	const requestUrl = new URL(c.req.url);
	const redirectUri = getCallbackUri(requestUrl);
	const clientId = getClientId(requestUrl);

	if (!server.tokenEndpoint) {
		return c.redirect('/signin?indieauth_error=no_token_endpoint', 302);
	}

	// Exchange code for token
	const tokenRes = await fetch(server.tokenEndpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
		body: JSON.stringify({
			grant_type: 'authorization_code',
			code,
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: MISSKEY_OAUTH_SCOPE,
			code_verifier: codeVerifier,
		}),
	});

	if (!tokenRes.ok) {
		const body = await tokenRes.text();
		console.error('IndieAuth token exchange failed:', body);
		return c.redirect('/signin?indieauth_error=token_exchange_failed', 302);
	}

	const tokenData = (await tokenRes.json()) as MisskeyTokenResponse;
	const account = tokenData.access_token
		? await fetchMisskeyAccount(server.issuer, tokenData.access_token)
		: null;

	const canonicalMe = tokenData.me
		?? (account?.id ? `${server.issuer}/users/${account.id}` : profileUrl);

	// Use the profile URL as the misskey_id (canonical identifier)
	const misskeyId = canonicalMe;

	// Check if user exists with this misskeyId
	let user = await db.select().from(users).where(eq(users.misskeyId, misskeyId)).get();

	if (user) {
		if (user.isSuspended) {
			return c.redirect('/signin?indieauth_error=suspended', 302);
		}
	} else {
		// New IndieAuth user — check if registration is allowed
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
				return c.redirect('/signin?indieauth_error=registration_closed', 302);
			}
		}

		if (registrationMode === 'passphrase') {
			const signupPassphrase = c.env.SIGNUP_PASSPHRASE;
			if (!signupPassphrase || !storedState.signupPassphrase || storedState.signupPassphrase !== signupPassphrase) {
				return c.redirect('/signin?indieauth_error=invalid_passphrase', 302);
			}
		}

		const username = storedState.signupUsername?.trim();
		if (!username) {
			return c.redirect('/signin?indieauth_error=missing_username', 302);
		}

		if (!isValidNameFormat(username)) {
			return c.redirect('/signin?indieauth_error=invalid_username', 302);
		}

		if (!isFirstUser) {
			const usernameError = await validateUsername(db, username);
			if (usernameError) {
				const error = usernameError === 'Username already exists' ? 'username_taken' : 'invalid_username';
				return c.redirect(`/signin?indieauth_error=${error}`, 302);
			}
		}

		const userId = genEaidx(Date.now());
		await db.insert(users).values({
			id: userId,
			username,
			passwordHash: null,
			googleId: null,
			misskeyId,
			isAdmin: isFirstUser,
			isSuspended: false,
		});

		await db
			.insert(usedUsernames)
			.values({ username: username.toLowerCase() })
			.onConflictDoNothing();

		user = await db.select().from(users).where(eq(users.id, userId)).get();
		if (!user) {
			return c.redirect('/signin?indieauth_error=user_creation_failed', 302);
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

	return c.redirect(`/signin?indieauth_token=${encodeURIComponent(tokenValue)}`, 302);
});

// API endpoint to complete IndieAuth sign-in from the frontend (exchange temp token)
app.post('/complete', async (c) => {
	const body = (await c.req.json()) as { indieauthToken?: string };

	if (!body.indieauthToken) {
		throw new HTTPException(400, { message: 'indieauthToken is required' });
	}

	const db = getDb(c.env);
	const tokenRecord = await db.select().from(tokens).where(eq(tokens.token, body.indieauthToken)).get();
	if (!tokenRecord) {
		throw new HTTPException(401, { message: 'Invalid token' });
	}

	return c.json({ token: body.indieauthToken });
});

export const indieAuthRoutes = app;
