import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { appSettings } from '../scheme/index';
import { getDb } from '../utils/db';
import { shortGetCache } from '../middleware/short-get-cache';

const app = new Hono<{ Bindings: Env }>();

type MetaResponse = {
	registrationEnabled: boolean;
	passphraseRequired: boolean;
	turnstileEnabled: boolean;
	turnstileSiteKey: string;
	googleAuthEnabled: boolean;
	googleRequired: boolean;
	indieAuthEnabled: boolean;
};

function createMetaResponse(data: MetaResponse): Response {
	return new Response(JSON.stringify(data), {
		headers: {
			'Content-Type': 'application/json; charset=UTF-8',
		},
	});
}

app.use('/meta', shortGetCache({ maxAgeSeconds: 10 }));

app.get('/meta', async (c) => {
	const db = getDb(c.env);

	try {
		const registrationModeSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'registration_mode'))
			.get();

		const mode = registrationModeSetting?.value ?? 'passphrase';

		const googleRequiredSetting = await db
			.select()
			.from(appSettings)
			.where(eq(appSettings.key, 'google_required'))
			.get();

		const googleRequired = googleRequiredSetting?.value === 'true';
		const googleAuthEnabled = (c.env.GOOGLE_CLIENT_ID as string) !== '' && (c.env.GOOGLE_CLIENT_SECRET as string) !== '';

		return createMetaResponse({
			registrationEnabled: mode !== 'closed',
			passphraseRequired: mode === 'passphrase',
			turnstileEnabled: (c.env.TURNSTILE_SECRET as string) !== '',
			turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
			googleAuthEnabled,
			googleRequired,
			indieAuthEnabled: true,
		});
	} catch {
		return createMetaResponse({
			registrationEnabled: true,
			passphraseRequired: true,
			turnstileEnabled: false,
			turnstileSiteKey: '',
			googleAuthEnabled: false,
			googleRequired: false,
			indieAuthEnabled: true,
		});
	}
});

export const metaRoutes = app;
