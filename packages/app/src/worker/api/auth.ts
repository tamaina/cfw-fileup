import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, count, and } from 'drizzle-orm';
import { users, tokens, appSettings, usedUsernames, passkeys, backupCodes } from '../scheme/index';
import { getDb } from '../utils/db';
import { hashPassword, verifyPassword, generateToken } from '../utils/crypto';
import { genEaidx } from '../../shared/eaid-x';
import { verifyTurnstile } from '../utils/turnstile';
import { validateUsername } from '../utils/name-validation';
import { apiDef, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';

const app = new Hono<{ Bindings: Env }>();

function uint8ArrayToBase64(arr: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < arr.length; i++) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		binary += String.fromCharCode(arr[i]!);
	}
	return btoa(binary);
}

async function hashBackupCode(code: string): Promise<string> {
	const data = new TextEncoder().encode(code);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return uint8ArrayToBase64(new Uint8Array(hashBuffer));
}

app.post(
	'/signup',
	describeRoute(omitResAndReq(apiDef['/api/signup'])),
	validator('json', apiDef['/api/signup'].req),
	describeResponse(async (c: JsonCtx<'/api/signup', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		// username は schema で trim・minLength・maxLength・regex 検証済み
		const { username, password } = body;

		if ((c.env.TURNSTILE_SECRET as string) !== '') {
			const token = body.turnstileToken;
			if (!token || !await verifyTurnstile(token, c.env.TURNSTILE_SECRET)) {
				throw new HTTPException(400, { message: 'Turnstile verification failed' });
			}
		}

		const userCount = await db.select({ count: count() }).from(users);
		const isFirstUser = (userCount[0]?.count ?? 0) === 0;

		if (!isFirstUser) {
			const googleRequiredSetting = await db
				.select()
				.from(appSettings)
				.where(eq(appSettings.key, 'google_required'))
				.get();

			if (googleRequiredSetting?.value === 'true') {
				throw new HTTPException(403, { message: 'Only Google account registration is allowed' });
			}
		}

		const registrationModeSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'registration_mode'))
			.get();

		const registrationMode = (registrationModeSetting?.value ?? 'passphrase') as 'closed' | 'passphrase' | 'open';

		if (!isFirstUser && registrationMode === 'closed') {
			throw new HTTPException(403, { message: 'Registration is closed' });
		}

		if (registrationMode === 'passphrase') {
			const signupPassphrase = c.env.SIGNUP_PASSPHRASE;
			if (!signupPassphrase || !body.passphrase || body.passphrase !== signupPassphrase) {
				throw new HTTPException(403, { message: 'Invalid passphrase' });
			}
		}

		// 最初のユーザー（admin）は禁止名・重複チェックをスキップ
		if (!isFirstUser) {
			const usernameError = await validateUsername(db, username);
			if (usernameError) {
				const status = usernameError === 'Username already exists' ? 409 : 400;
				throw new HTTPException(status, { message: usernameError });
			}
		}

		const userId = genEaidx(Date.now());
		const passwordHash = await hashPassword(password);

		await db.insert(users).values({
			id: userId,
			username,
			passwordHash,
			isAdmin: isFirstUser,
			isSuspended: false,
		});

		// lowercaseで used_usernames に登録（削除後も同名再利用不可）
		await db
			.insert(usedUsernames)
			.values({ username: username.toLowerCase() })
			.onConflictDoNothing();

		const tokenId = genEaidx(Date.now());
		const tokenValue = generateToken();

		await db.insert(tokens).values({
			id: tokenId,
			userId,
			token: tokenValue,
		});

		return c.json({ userId, token: tokenValue }, 200);
	}, apiDef['/api/signup'].res),
);

app.post(
	'/signin',
	describeRoute(omitResAndReq(apiDef['/api/signin'])),
	validator('json', apiDef['/api/signin'].req),
	describeResponse(async (c: JsonCtx<'/api/signin', Env>) => {
		const db = getDb(c.env);
		const body = c.req.valid('json');
		const { username, password } = body;

		if ((c.env.TURNSTILE_SECRET as string) !== '') {
			const token = body.turnstileToken;
			if (!token || !await verifyTurnstile(token, c.env.TURNSTILE_SECRET)) {
				throw new HTTPException(400, { message: 'Turnstile verification failed' });
			}
		}

		const user = await db.select().from(users).where(eq(users.username, username)).get();

		if (!user) {
			throw new HTTPException(401, { message: 'Invalid credentials' });
		}

		if (user.isSuspended) {
			throw new HTTPException(401, { message: 'Account is suspended' });
		}

		const googleRequiredSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'google_required'))
			.get();

		if (googleRequiredSetting?.value === 'true') {
			throw new HTTPException(403, { message: 'Only Google account sign-in is allowed' });
		}

		if (!user.passwordHash) {
			throw new HTTPException(401, { message: 'Invalid credentials' });
		}
		const passwordValid = await verifyPassword(password, user.passwordHash);
		if (!passwordValid) {
			throw new HTTPException(401, { message: 'Invalid credentials' });
		}

		const userPasskeys = await db
			.select({ id: passkeys.id })
			.from(passkeys)
			.where(eq(passkeys.userId, user.id))
			.limit(1);

		if (userPasskeys.length > 0) {
			const normalizedBackupCode = body.backupCode?.toUpperCase().replace(/[\s-]/g, '') ?? '';
			if (!normalizedBackupCode) {
				throw new HTTPException(401, { message: 'Backup code required' });
			}

			const codeHash = await hashBackupCode(normalizedBackupCode);
			const codeRecord = await db
				.select()
				.from(backupCodes)
				.where(and(eq(backupCodes.userId, user.id), eq(backupCodes.codeHash, codeHash)))
				.get();

			if (!codeRecord || codeRecord.usedAt !== null) {
				throw new HTTPException(401, { message: 'Invalid credentials or code' });
			}

			await db.update(backupCodes).set({ usedAt: Date.now() }).where(eq(backupCodes.id, codeRecord.id));
		}

		const tokenId = genEaidx(Date.now());
		const tokenValue = generateToken();

		await db.insert(tokens).values({
			id: tokenId,
			userId: user.id,
			token: tokenValue,
		});

		return c.json({ token: tokenValue }, 200);
	}, apiDef['/api/signin'].res),
);

export const authRoutes = app;
