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

		return c.json({
			registrationEnabled: registrationEnabledSetting?.value !== 'false',
			passphraseRequired: !!passphraseRequired,
		} as ExtractResponseType<typeof metaApiSchema, '/api/meta', 'get', 200>);
	} catch {
		return c.json({
			registrationEnabled: true,
			passphraseRequired: false,
		} as ExtractResponseType<typeof metaApiSchema, '/api/meta', 'get', 200>);
	}
});

export const metaRoutes = app;
