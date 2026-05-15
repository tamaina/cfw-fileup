import { Hono } from 'hono';
import { eq, count } from 'drizzle-orm';
import { appSettings, users } from '../scheme/index';
import { getDb } from '../utils/db';

const app = new Hono<{ Bindings: Env }>();

app.get('/meta', async (c) => {
	const db = getDb(c.env);

	const registrationEnabledSetting = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.key, 'registration_enabled'))
		.get();

	const userCountResult = await db.select({ count: count() }).from(users);
	const isFirstUser = (userCountResult[0]?.count ?? 0) === 0;

	const requireSignupPassphraseSetting = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.key, 'require_signup_passphrase'))
		.get();

	const requireSignupPassphrase = requireSignupPassphraseSetting?.value === 'true';
	const passphraseRequired = requireSignupPassphrase && !isFirstUser;

	return c.json({
		registrationEnabled: registrationEnabledSetting?.value !== 'false',
		passphraseRequired: !!passphraseRequired,
	});
});

export default app;
