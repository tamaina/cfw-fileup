import { appSettings } from '../scheme/index';
import { getDb } from './db';
import { getAppSettingCached, setAppSettingCache } from './app-settings-cache';

export const workerCacheVersionSettingKey = 'worker_cache_version';

const defaultWorkerCacheVersion = '1';

export async function getWorkerCacheVersion(env: Env): Promise<string> {
	return await getAppSettingCached(env, workerCacheVersionSettingKey) ?? defaultWorkerCacheVersion;
}

/**
 * /d のレスポンスを入れる Cache API のキャッシュ。
 * キャッシュバージョンはキャッシュ名ではなくキャッシュキー（`v`）に入れる。
 */
export function openDownloadCache(): Promise<Cache> {
	return caches.open('download');
}

/**
 * 管理画面の「Worker キャッシュをパージ」で使う。
 * Cache API の `cache.delete` は実行したデータセンターのキャッシュしか消せず、
 * 全データセンターを消すにはゾーンのパージ API（API トークンが必要）を使うしかないため、
 * キャッシュキーに入れているバージョンを変えて古いエントリーを使わないようにする。
 */
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
	await setAppSettingCache(workerCacheVersionSettingKey, version);

	return version;
}
