import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, count, lt } from 'drizzle-orm';
import { users, tokens, appSettings, oauthStates } from '../scheme/index';
import { getDb } from '../utils/db';
import { generateToken } from '../utils/crypto';
import { genEaidx } from '../../shared/eaid-x';
import { indieAuthApiSchema } from './indieauth.definition';
import type { ExtractResponseType } from './schema-type';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

/**
 * Discover IndieAuth authorization_endpoint from a profile URL.
 * Checks HTTP Link header first, then HTML <link rel="authorization_endpoint">.
 */
async function discoverAuthorizationEndpoint(profileUrl: string): Promise<string | null> {
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

	// Check Link header first (RFC 5988)
	const linkHeader = res.headers.get('Link');
	if (linkHeader) {
		const match = linkHeader.match(/<([^>]+)>\s*;\s*rel="authorization_endpoint"/i)
			?? linkHeader.match(/<([^>]+)>\s*;\s*rel=authorization_endpoint/i);
		if (match?.[1]) {
			return new URL(match[1], profileUrl).toString();
		}
	}

	// Parse HTML for <link rel="authorization_endpoint" href="...">
	const html = await res.text();
	// Simple regex to find link tags with rel=authorization_endpoint
	const linkTagPattern = /<link[^>]+>/gi;
	let linkMatch: RegExpExecArray | null;
	while ((linkMatch = linkTagPattern.exec(html)) !== null) {
		const tag = linkMatch[0];
		if (/rel=["']?authorization_endpoint["']?/i.test(tag)) {
			const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
			if (hrefMatch?.[1]) {
				return new URL(hrefMatch[1], profileUrl).toString();
			}
		}
	}

	return null;
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

function getCallbackUri(env: Env, requestUrl: URL): string {
	return `${requestUrl.protocol}//${requestUrl.host}/api/auth/indieauth/callback`;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/begin', async (c) => {
	const profileUrlRaw = c.req.query('profile_url');
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

	const authEndpoint = await discoverAuthorizationEndpoint(profileUrl);
	if (!authEndpoint) {
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
		expiresAt,
	});

	const requestUrl = new URL(c.req.url);
	const redirectUri = getCallbackUri(c.env, requestUrl);

	const authUrl = new URL(authEndpoint);
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('client_id', `${requestUrl.protocol}//${requestUrl.host}/`);
	authUrl.searchParams.set('redirect_uri', redirectUri);
	authUrl.searchParams.set('state', state);
	authUrl.searchParams.set('code_challenge', codeChallenge);
	authUrl.searchParams.set('code_challenge_method', 'S256');
	authUrl.searchParams.set('scope', 'profile');
	authUrl.searchParams.set('me', profileUrl);

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

	// Re-discover authorization endpoint to get token endpoint
	const authEndpoint = await discoverAuthorizationEndpoint(profileUrl);
	if (!authEndpoint) {
		return c.redirect('/signin?indieauth_error=discovery_failed', 302);
	}

	const requestUrl = new URL(c.req.url);
	const redirectUri = getCallbackUri(c.env, requestUrl);

	// Discover token endpoint from the auth endpoint URL page
	// IndieAuth spec: the token endpoint is linked from the authorization endpoint
	// In practice for Misskey, token endpoint = auth endpoint with POST method
	// We need to fetch the auth endpoint page and look for rel="token_endpoint"
	const tokenEndpoint = await discoverTokenEndpoint(authEndpoint, profileUrl);
	if (!tokenEndpoint) {
		return c.redirect('/signin?indieauth_error=no_token_endpoint', 302);
	}

	// Exchange code for token
	const tokenRes = await fetch(tokenEndpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: `${requestUrl.protocol}//${requestUrl.host}/`,
			redirect_uri: redirectUri,
			code_verifier: codeVerifier,
		}),
	});

	if (!tokenRes.ok) {
		const body = await tokenRes.text();
		console.error('IndieAuth token exchange failed:', body);
		return c.redirect('/signin?indieauth_error=token_exchange_failed', 302);
	}

	const tokenData = (await tokenRes.json()) as { me?: string; access_token?: string; profile?: { name?: string; url?: string } };

	// The canonical "me" URL returned by the server is the authoritative profile URL
	const canonicalMe = tokenData.me ?? profileUrl;

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

		if (!isFirstUser) {
			const registrationEnabled = await db
				.select()
				.from(appSettings)
				.where(eq(appSettings.key, 'registration_enabled'))
				.get();

			if (registrationEnabled?.value === 'false') {
				return c.redirect('/signin?indieauth_error=registration_closed', 302);
			}
		}

		// Generate username from profile
		const profileName = tokenData.profile?.name;
		const urlPath = new URL(canonicalMe).pathname.replace(/^\//, '').replace(/@/g, '').replace(/[^a-zA-Z0-9_-]/g, '_');
		const nameSource = profileName?.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 28) ?? urlPath.slice(0, 28);
		const baseUsername = nameSource || 'misskey_user';

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
			googleId: null,
			misskeyId,
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
	type CompleteRes = ExtractResponseType<typeof indieAuthApiSchema, '/api/auth/indieauth/complete', 'post', 200>;
	const body = (await c.req.json()) as { indieauthToken?: string };

	if (!body.indieauthToken) {
		throw new HTTPException(400, { message: 'indieauthToken is required' });
	}

	const db = getDb(c.env);
	const tokenRecord = await db.select().from(tokens).where(eq(tokens.token, body.indieauthToken)).get();
	if (!tokenRecord) {
		throw new HTTPException(401, { message: 'Invalid token' });
	}

	return c.json({ token: body.indieauthToken } as CompleteRes);
});

/**
 * Discover token_endpoint from an authorization endpoint URL.
 * Checks Link headers and HTML <link rel="token_endpoint">.
 */
async function discoverTokenEndpoint(authEndpoint: string, profileUrl: string): Promise<string | null> {
	// For Misskey-style IndieAuth, the token endpoint is typically indicated on the
	// IndieAuth server's authorization endpoint page.
	// Per IndieAuth spec, we should look for rel="token_endpoint" on the auth endpoint page.
	let res: Response;
	try {
		res = await fetch(authEndpoint, {
			headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
		});
	} catch {
		// Fallback: try the profile URL's token_endpoint
		return discoverTokenEndpointFromProfile(profileUrl);
	}

	if (!res.ok) {
		return discoverTokenEndpointFromProfile(profileUrl);
	}

	// Check Link header
	const linkHeader = res.headers.get('Link');
	if (linkHeader) {
		const match = linkHeader.match(/<([^>]+)>\s*;\s*rel="token_endpoint"/i)
			?? linkHeader.match(/<([^>]+)>\s*;\s*rel=token_endpoint/i);
		if (match?.[1]) {
			return new URL(match[1], authEndpoint).toString();
		}
	}

	// Parse HTML for <link rel="token_endpoint" href="...">
	const html = await res.text();
	const linkTagPattern = /<link[^>]+>/gi;
	let linkMatch: RegExpExecArray | null;
	while ((linkMatch = linkTagPattern.exec(html)) !== null) {
		const tag = linkMatch[0];
		if (/rel=["']?token_endpoint["']?/i.test(tag)) {
			const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
			if (hrefMatch?.[1]) {
				return new URL(hrefMatch[1], authEndpoint).toString();
			}
		}
	}

	// Fallback: try discovering from the profile URL itself
	return discoverTokenEndpointFromProfile(profileUrl);
}

/**
 * Discover token_endpoint from the user's profile URL.
 */
async function discoverTokenEndpointFromProfile(profileUrl: string): Promise<string | null> {
	let res: Response;
	try {
		res = await fetch(profileUrl, {
			headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
		});
	} catch {
		return null;
	}

	if (!res.ok) return null;

	// Check Link header
	const linkHeader = res.headers.get('Link');
	if (linkHeader) {
		const match = linkHeader.match(/<([^>]+)>\s*;\s*rel="token_endpoint"/i)
			?? linkHeader.match(/<([^>]+)>\s*;\s*rel=token_endpoint/i);
		if (match?.[1]) {
			return new URL(match[1], profileUrl).toString();
		}
	}

	// Parse HTML
	const html = await res.text();
	const linkTagPattern = /<link[^>]+>/gi;
	let linkMatch: RegExpExecArray | null;
	while ((linkMatch = linkTagPattern.exec(html)) !== null) {
		const tag = linkMatch[0];
		if (/rel=["']?token_endpoint["']?/i.test(tag)) {
			const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
			if (hrefMatch?.[1]) {
				return new URL(hrefMatch[1], profileUrl).toString();
			}
		}
	}

	return null;
}

export const indieAuthRoutes = app;
