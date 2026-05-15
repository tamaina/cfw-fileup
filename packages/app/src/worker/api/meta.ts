import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { appSettings } from '../scheme/index';
import { getDb } from '../utils/db';

const app = new Hono<{ Bindings: Env }>();

app.get('/meta', async (c) => {
	const db = getDb(c.env);

	const registrationEnabledSetting = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.key, 'registration_enabled'))
		.get();

	return c.json({
		registrationEnabled: registrationEnabledSetting?.value !== 'false',
	});
});

export default app;
