import { env } from 'cloudflare:workers';
import app from '../../src/worker/index';

export { env, app };

// Create all DB tables (idempotent)
export async function setupDb(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
			id text PRIMARY KEY NOT NULL,
			username text NOT NULL UNIQUE,
			password_hash text NOT NULL,
			is_admin integer DEFAULT false NOT NULL,
			is_suspended integer DEFAULT false NOT NULL
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS tokens (
			id text PRIMARY KEY NOT NULL,
			user_id text NOT NULL,
			token text NOT NULL UNIQUE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS buckets (
			id text PRIMARY KEY NOT NULL,
			user_id text NOT NULL,
			name text NOT NULL UNIQUE,
			used_bytes integer NOT NULL DEFAULT 0,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS files (
			id text PRIMARY KEY NOT NULL,
			bucket_id text NOT NULL,
			user_id text NOT NULL,
			path text NOT NULL,
			r2_key text NOT NULL UNIQUE,
			size integer,
			mime_type text,
			is_public integer DEFAULT true NOT NULL,
			passphrase text,
			upload_expires_at integer NOT NULL,
			is_closed integer DEFAULT false NOT NULL,
			is_targz integer DEFAULT false NOT NULL,
			is_tar integer DEFAULT false NOT NULL,
			upload_id text,
			part_size integer NOT NULL DEFAULT 33554432,
			FOREIGN KEY (bucket_id) REFERENCES buckets(id) ON DELETE CASCADE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)`),
		env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS files_bucket_path_idx ON files (bucket_id, path)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS targz_files (
			id text PRIMARY KEY NOT NULL,
			file_id text NOT NULL,
			path text NOT NULL,
			mime_type text NOT NULL,
			a_start integer NOT NULL,
			a_first_end integer NOT NULL DEFAULT 0,
			a_final_start integer NOT NULL,
			a_end integer NOT NULL,
			r_start_offset integer NOT NULL,
			r_end_offset integer NOT NULL,
			FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS tar_files (
			id text PRIMARY KEY NOT NULL,
			file_id text NOT NULL,
			path text NOT NULL,
			mime_type text NOT NULL,
			offset integer NOT NULL,
			size integer NOT NULL,
			FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS upload_parts (
			id text PRIMARY KEY NOT NULL,
			file_id text NOT NULL,
			part_number integer NOT NULL,
			etag text NOT NULL,
			FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
			key text PRIMARY KEY NOT NULL,
			value text NOT NULL
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS global_quotas (
			key text PRIMARY KEY NOT NULL,
			max_buckets integer,
			max_bucket_size_bytes integer,
			max_files_per_bucket integer,
			max_daily_uploads integer
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_quotas (
			user_id text PRIMARY KEY NOT NULL,
			max_buckets integer,
			max_bucket_size_bytes integer,
			max_files_per_bucket integer,
			max_daily_uploads integer,
			updated_at integer NOT NULL,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)`),
	]);
}

// Clear all data between tests (delete in dependency order)
export async function clearDb(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM upload_parts'),
		env.DB.prepare('DELETE FROM targz_files'),
		env.DB.prepare('DELETE FROM tar_files'),
		env.DB.prepare('DELETE FROM files'),
		env.DB.prepare('DELETE FROM tokens'),
		env.DB.prepare('DELETE FROM user_quotas'),
		env.DB.prepare('DELETE FROM buckets'),
		env.DB.prepare('DELETE FROM users'),
		env.DB.prepare('DELETE FROM app_settings'),
		env.DB.prepare('DELETE FROM global_quotas'),
	]);
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
	const { data } = await signup('admin');
	return { userId: String(data.userId), token: String(data.token) };
}

// Create a regular second user and return token
export async function createRegularUser(username = 'user1'): Promise<{ userId: string; token: string }> {
	await signup('admin');
	const { data } = await signup(username);
	return { userId: String(data.userId), token: String(data.token) };
}
