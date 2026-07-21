import { env as workerEnv } from 'cloudflare:workers';
import workerApp from '../../src/worker/index';
import { deleteAppSettingCache } from '../../src/worker/utils/app-settings-cache';
import migration0000 from '../../migrations/0000_curly_lady_deathstrike.sql?raw';
import migration0001 from '../../migrations/0001_confused_wild_child.sql?raw';
import migration0002 from '../../migrations/0002_last_whizzer.sql?raw';
import migration0003 from '../../migrations/0003_lazy_calypso.sql?raw';

const defaultCf = {
	country: 'JP',
	isEUCountry: false,
	city: 'Tokyo',
	continent: 'AS',
	latitude: '35.68950',
	longitude: '139.69171',
	postalCode: '100-0001',
	metroCode: null,
	region: 'Tokyo',
	regionCode: '13',
	timezone: 'Asia/Tokyo',
};

export const rawApp = workerApp;
export const env = Object.assign(workerEnv, {
	TURNSTILE_SECRET: '',
	AUTH_RATE_LIMITER: undefined,
	FILE_PASSPHRASE_RATE_LIMITER: undefined,
	PUBLIC_FORM_RATE_LIMITER: undefined,
});
export const app = {
	request: ((input: Parameters<typeof workerApp.request>[0], init?: Parameters<typeof workerApp.request>[1], envArg?: Parameters<typeof workerApp.request>[2]) => {
		if (input instanceof Request) return workerApp.request(input, init, envArg);
		return workerApp.request(input, { ...init, cf: (init as { cf?: unknown } | undefined)?.cf ?? defaultCf } as Parameters<typeof workerApp.request>[1], envArg);
	}) as typeof workerApp.request,
};

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

const migrations = [
	migration0000,
	migration0001,
	migration0002,
	migration0003,
] as const;

const tables = [
	'upload_parts',
	'targz_files',
	'tar_files',
	'file_access_tokens',
	'file_reports',
	'crypto_payment_orders',
	'billing_residency_statements',
	'wallet_link_challenges',
	'user_wallets',
	'payment_asset_plan_prices',
	'payment_asset_deployments',
	'payment_assets',
	'payment_chains',
	'ip_bans',
	'moderation_audit_logs',
	'moderation_events',
	'passkeys_challenges',
	'backup_codes',
	'passkeys',
	'misskey_accounts',
	'files',
	'directories',
	'oauth_states',
	'email_verification_tokens',
	'email_notification_events',
	'tokens',
	'user_plan_assignments',
	'user_quotas',
	'buckets',
	'users',
	'app_settings',
	'global_quotas',
	'plans',
	'used_bucket_names',
] as const;

async function executeSql(sql: string): Promise<void> {
	const statements = sql
		.split('--> statement-breakpoint')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);

	for (const statement of statements) {
		await env.DB.prepare(statement).run();
	}
}

// Recreate the test database from the same Drizzle migrations used by D1.
export async function setupDb(): Promise<void> {
	await env.DB.prepare('PRAGMA foreign_keys=OFF').run();
	for (const table of tables) {
		await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	}
	await env.DB.prepare('PRAGMA foreign_keys=ON').run();

	for (const migration of migrations) {
		await executeSql(migration);
	}

	await env.DB.prepare('UPDATE app_settings SET value = \'open\' WHERE key = \'registration_mode\'').run();
	await deleteAppSettingCache('worker_cache_version');
	await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'worker_cache_version\', ?)').bind(`test-${Date.now()}-${Math.random()}`).run();
}

// Clear all data between tests (delete in dependency order)
export async function clearDb(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM upload_parts'),
		env.DB.prepare('DELETE FROM targz_files'),
		env.DB.prepare('DELETE FROM tar_files'),
		env.DB.prepare('DELETE FROM file_access_tokens'),
		env.DB.prepare('DELETE FROM file_reports'),
		env.DB.prepare('DELETE FROM crypto_payment_orders'),
		env.DB.prepare('DELETE FROM wallet_link_challenges'),
		env.DB.prepare('DELETE FROM user_wallets'),
		env.DB.prepare('DELETE FROM payment_asset_plan_prices'),
		env.DB.prepare('DELETE FROM payment_asset_deployments'),
		env.DB.prepare('DELETE FROM payment_assets'),
		env.DB.prepare('DELETE FROM payment_chains'),
		env.DB.prepare('DELETE FROM ip_bans'),
		env.DB.prepare('DELETE FROM moderation_audit_logs'),
		env.DB.prepare('DELETE FROM moderation_events'),
		env.DB.prepare('DELETE FROM passkeys_challenges'),
		env.DB.prepare('DELETE FROM backup_codes'),
		env.DB.prepare('DELETE FROM passkeys'),
		env.DB.prepare('DELETE FROM misskey_accounts'),
		env.DB.prepare('DELETE FROM files'),
		env.DB.prepare('DELETE FROM directories'),
		env.DB.prepare('DELETE FROM oauth_states'),
		env.DB.prepare('DELETE FROM email_verification_tokens'),
		env.DB.prepare('DELETE FROM email_notification_events'),
		env.DB.prepare('DELETE FROM tokens'),
		env.DB.prepare('DELETE FROM user_plan_assignments'),
		env.DB.prepare('DELETE FROM user_quotas'),
		env.DB.prepare('DELETE FROM buckets'),
		env.DB.prepare('DELETE FROM users'),
		env.DB.prepare('DELETE FROM app_settings'),
		env.DB.prepare('DELETE FROM global_quotas'),
		env.DB.prepare('DELETE FROM plans'),
		env.DB.prepare('DELETE FROM used_bucket_names'),
	]);
	await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'registration_mode\', \'open\')').run();
	await deleteAppSettingCache('worker_cache_version');
	await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'worker_cache_version\', ?)').bind(`test-${Date.now()}-${Math.random()}`).run();
}

// Sign up a user and return status + response data
export async function signup(
	username: string,
	password = 'password123',
	extra?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
	const passphrase = (env as Record<string, string>).SIGNUP_PASSPHRASE;
	const res = await app.request(
		'/api/signup',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password, ...(passphrase ? { passphrase } : {}), ...extra }),
		},
		env,
	);
	return { status: res.status, data: await res.json() as Record<string, unknown> };
}

// Sign in and return status + response data
export async function signin(
	username: string,
	password: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await app.request(
		'/api/signin',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password }),
		},
		env,
	);
	return { status: res.status, data: await res.json() as Record<string, unknown> };
}

// Build Authorization + Content-Type headers
export function authHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
	};
}

// Create admin user (first signup) and return token
export async function createAdminUser(): Promise<{ userId: string; token: string }> {
	const { data } = await signup('firstuser');
	return { userId: String(data.userId), token: String(data.token) };
}

// Create a regular second user and return token
export async function createRegularUser(username = 'user1'): Promise<{ userId: string; token: string }> {
	await signup('firstuser');
	const { data } = await signup(username);
	return { userId: String(data.userId), token: String(data.token) };
}
