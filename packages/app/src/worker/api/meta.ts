import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { appSettings } from '../scheme/index';
import { getDb } from '../utils/db';

const app = new Hono<{ Bindings: Env }>();

app.get('/meta', async (c) => {
	const db = getDb(c.env);

	try {
		const registrationModeSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'registration_mode'))
			.get();

		const mode = registrationModeSetting?.value ?? 'passphrase';

		return c.json({
			registrationEnabled: mode !== 'closed',
			passphraseRequired: mode === 'passphrase',
			turnstileEnabled: (c.env.TURNSTILE_SECRET as string) !== '',
			turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
		});
	} catch {
		return c.json({
			registrationEnabled: true,
			passphraseRequired: true,
			turnstileEnabled: false,
			turnstileSiteKey: '',
		});
	}
});

export const metaRoutes = app;
