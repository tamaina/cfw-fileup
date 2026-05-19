import { env } from 'cloudflare:workers';
import app from '../../src/worker/index';
import migration0000 from '../../migrations/0000_rich_gressill.sql?raw';

export { env, app };

const migrations = [
	migration0000,
] as const;

const tables = [
	'upload_parts',
	'targz_files',
	'tar_files',
	'file_access_tokens',
	'passkeys_challenges',
	'backup_codes',
	'passkeys',
	'files',
	'directories',
	'tokens',
	'user_quotas',
	'buckets',
	'users',
	'app_settings',
	'global_quotas',
	'used_usernames',
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

	await env.DB.prepare("UPDATE app_settings SET value = 'open' WHERE key = 'registration_mode'").run();
}

// Clear all data between tests (delete in dependency order)
export async function clearDb(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM upload_parts'),
		env.DB.prepare('DELETE FROM targz_files'),
		env.DB.prepare('DELETE FROM tar_files'),
		env.DB.prepare('DELETE FROM file_access_tokens'),
		env.DB.prepare('DELETE FROM passkeys_challenges'),
		env.DB.prepare('DELETE FROM backup_codes'),
		env.DB.prepare('DELETE FROM passkeys'),
		env.DB.prepare('DELETE FROM files'),
		env.DB.prepare('DELETE FROM directories'),
		env.DB.prepare('DELETE FROM tokens'),
		env.DB.prepare('DELETE FROM user_quotas'),
		env.DB.prepare('DELETE FROM buckets'),
		env.DB.prepare('DELETE FROM users'),
		env.DB.prepare('DELETE FROM app_settings'),
		env.DB.prepare('DELETE FROM global_quotas'),
		env.DB.prepare('DELETE FROM used_usernames'),
		env.DB.prepare('DELETE FROM used_bucket_names'),
	]);
	await env.DB.prepare("INSERT INTO app_settings (key, value) VALUES ('registration_mode', 'open')").run();
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
