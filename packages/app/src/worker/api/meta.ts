import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { appSettings } from '../scheme/index';
import { getDb } from '../utils/db';
import { metaApiSchema } from './meta.definition';
import type { ExtractResponseType } from './schema-type';

const app = new Hono<{ Bindings: Env }>();

app.get('/meta', async (c) => {
	const db = getDb(c.env);

	try {
		const registrationEnabledSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'registration_enabled'))
			.get();

		const requireSignupPassphraseSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'require_signup_passphrase'))
			.get();

		const requireSignupPassphrase = requireSignupPassphraseSetting?.value === 'true';
		const passphraseRequired = requireSignupPassphrase;

		const googleRequiredSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'google_required'))
			.get();

		const googleRequired = googleRequiredSetting?.value === 'true';
		const googleAuthEnabled = (c.env.GOOGLE_CLIENT_ID as string) !== '' && (c.env.GOOGLE_CLIENT_SECRET as string) !== '';

		return c.json({
			registrationEnabled: registrationEnabledSetting?.value !== 'false',
			passphraseRequired: !!passphraseRequired,
			turnstileEnabled: (c.env.TURNSTILE_SECRET as string) !== '',
			turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
			googleAuthEnabled,
			googleRequired,
			indieAuthEnabled: true,
		} as ExtractResponseType<typeof metaApiSchema, '/api/meta', 'get', 200>);
	} catch {
		return c.json({
			registrationEnabled: true,
			passphraseRequired: false,
			turnstileEnabled: false,
			turnstileSiteKey: '',
			googleAuthEnabled: false,
			googleRequired: false,
			indieAuthEnabled: true,
		} as ExtractResponseType<typeof metaApiSchema, '/api/meta', 'get', 200>);
	}
});

export const metaRoutes = app;
