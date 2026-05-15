import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { appSettings } from '../scheme/index';
import { getDb } from '../utils/db';
import type { ExtractResponseType } from './schema-type';
import { metaApiSchema } from './meta.definition';

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

		type MetaRes = ExtractResponseType<typeof metaApiSchema, '/api/meta', 'get', 200>;
		const response: MetaRes = {
			registrationEnabled: registrationEnabledSetting?.value !== 'false',
			passphraseRequired: !!passphraseRequired,
		};
		return c.json(response);
	} catch {
		type MetaRes = ExtractResponseType<typeof metaApiSchema, '/api/meta', 'get', 200>;
		const response: MetaRes = {
			registrationEnabled: true,
			passphraseRequired: false,
		};
		return c.json(response);
	}
});

export default app;
