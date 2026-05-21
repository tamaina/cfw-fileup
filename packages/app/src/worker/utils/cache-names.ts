import { eq } from 'drizzle-orm';
import { appSettings } from '../scheme/index';
import { getDb } from './db';

export const workerCacheBaseNames = {
	download: 'download',
	missingDownloadFile: 'download-file-not-found',
	shortGet: 'api-short-get',
} as const;

export const workerCacheVersionSettingKey = 'worker_cache_version';

const defaultWorkerCacheVersion = '1';

export type WorkerCacheBaseName = typeof workerCacheBaseNames[keyof typeof workerCacheBaseNames];

export async function getWorkerCacheVersion(env: Env): Promise<string> {
	const db = getDb(env);
	const setting = await db
		.select({ value: appSettings.value })
		.from(appSettings)
		.where(eq(appSettings.key, workerCacheVersionSettingKey))
		.get();

	return setting?.value ?? defaultWorkerCacheVersion;
}

export async function getWorkerCacheName(env: Env, baseName: WorkerCacheBaseName): Promise<string> {
	const version = await getWorkerCacheVersion(env);
	return `${baseName}-v${version}`;
}

export async function openWorkerCache(env: Env, baseName: WorkerCacheBaseName): Promise<Cache> {
	return caches.open(await getWorkerCacheName(env, baseName));
}

export async function bumpWorkerCacheVersion(env: Env): Promise<string> {
	const version = Date.now().toString(36);
	const db = getDb(env);
	await db
		.insert(appSettings)
		.values({
			key: workerCacheVersionSettingKey,
			value: version,
		})
		.onConflictDoUpdate({
			target: appSettings.key,
			set: { value: version },
		});

	return version;
}
