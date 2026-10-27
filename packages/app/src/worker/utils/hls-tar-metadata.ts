import { eq } from 'drizzle-orm';
import { files, tarFiles } from '../scheme/index';
import { HLS_TAR_MIME, hlsEntryDirname, hlsPosterEntryPath, parseHlsSessionData } from '../../shared/hls';
import { getWorkerCacheVersion } from './cache-names';
import { createInternalCacheRequest, matchShortCacheJson, putShortCacheJson } from './short-cache';
import type { getDb } from './db';

/** master.m3u8 として読む最大サイズ。tar index 改ざん対策の保険 */
const MAX_MASTER_PLAYLIST_BYTES = 256 * 1024;

/** tar エントリー一覧から master.m3u8 を特定する(最短パス優先) */
export function findHlsMasterEntry<T extends { path: string }>(entries: readonly T[]): T | undefined {
	return entries
		.filter(entry => entry.path.split('/').pop() === 'master.m3u8')
		.sort((a, b) => a.path.length - b.path.length)
		.at(0);
}

export interface HlsTarMetadata {
	masterEntryPath: string;
	title: string | null;
	/** tar 内に実在することを確認済みのポスターのエントリーパス */
	posterEntryPath: string | null;
}

type HlsTarMetadataFile = Pick<typeof files.$inferSelect, 'id' | 'r2Key' | 'mimeType' | 'isTar' | 'isClosed'>;

const hlsTarMetadataCacheName = 'hls-tar-metadata';
/** クローズ後のメタデータは基本的に変わらないので、/d の長期キャッシュと同じく実質永久（10 年）にする。 */
const hlsTarMetadataCacheTtlSeconds = 10 * 365 * 24 * 60 * 60;

/**
 * HLS tar の master.m3u8 を R2 からレンジ読みし、EXT-X-SESSION-DATA のタイトル/ポスターを解決する。
 * HLS tar でない場合や master.m3u8 が見つからない場合は null。
 * クローズ済みファイルの結果だけを、ファイル ID と全体のキャッシュバージョンをキーに Cache API へ実質永久に置く。
 * クローズ前の結果や、R2 の読み取りに失敗した結果はキャッシュしない。
 * 注意: /api/files/create/tar-index はクローズ後もアップロード期限までエントリーを追加できるので、
 * キャッシュ後に追加されたエントリーは管理画面のキャッシュパージまで反映されない。
 * 呼び出し側は必ず先に DB で公開状態を確認すること（キャッシュには公開状態を入れていない）。
 */
export async function getHlsTarMetadata(
	env: Env,
	db: ReturnType<typeof getDb>,
	file: HlsTarMetadataFile,
): Promise<HlsTarMetadata | null> {
	if (file.mimeType !== HLS_TAR_MIME || !file.isTar) return null;
	if (!file.isClosed) return (await loadHlsTarMetadata(env, db, file)).metadata;

	const cacheRequest = createInternalCacheRequest('/hls-tar-metadata', {
		k: '2',
		v: await getWorkerCacheVersion(env),
		fileId: file.id,
	});
	const cached = await matchShortCacheJson<HlsTarMetadata | null>(hlsTarMetadataCacheName, cacheRequest);
	if (cached) return cached.value;

	const { metadata, complete } = await loadHlsTarMetadata(env, db, file);
	if (complete) {
		try {
			await putShortCacheJson(hlsTarMetadataCacheName, cacheRequest, metadata, hlsTarMetadataCacheTtlSeconds);
		} catch (error) {
			console.error('Failed to put HLS tar metadata into cache:', error);
		}
	}
	return metadata;
}

/** `complete` が false のとき（R2 のオブジェクトが読めなかったとき）はキャッシュしない。 */
async function loadHlsTarMetadata(
	env: Env,
	db: ReturnType<typeof getDb>,
	file: HlsTarMetadataFile,
): Promise<{ metadata: HlsTarMetadata | null; complete: boolean }> {
	const entries = await db
		.select({ path: tarFiles.path, offset: tarFiles.offset, size: tarFiles.size })
		.from(tarFiles)
		.where(eq(tarFiles.fileId, file.id))
		.all();
	const master = findHlsMasterEntry(entries);
	if (!master) return { metadata: null, complete: true };

	let title: string | null = null;
	let posterUri: string | null = null;
	let complete = true;
	if (master.size > 0 && master.size <= MAX_MASTER_PLAYLIST_BYTES) {
		const object = await env.R2.get(file.r2Key, { range: { offset: master.offset, length: master.size } });
		if (object) {
			const meta = parseHlsSessionData(await object.text());
			title = meta.title;
			posterUri = meta.posterUri;
		} else {
			complete = false;
		}
	}

	const masterDir = hlsEntryDirname(master.path);
	const posterCandidates = new Set<string>([hlsPosterEntryPath(master.path)]);
	if (posterUri && !posterUri.includes('://') && !posterUri.startsWith('/')) {
		// master.m3u8 相対の URI を tar 内パスへ解決（".." は許可しない）
		const segments = posterUri.split('/');
		if (!segments.includes('..')) {
			posterCandidates.add(masterDir === '' ? segments.join('/') : `${masterDir}/${segments.join('/')}`);
		}
	}
	const posterEntryPath = entries.find(entry => posterCandidates.has(entry.path))?.path ?? null;

	return { metadata: { masterEntryPath: master.path, title, posterEntryPath }, complete };
}
