import { eq } from 'drizzle-orm';
import { files, tarFiles } from '../scheme/index';
import { HLS_TAR_MIME, hlsEntryDirname, hlsPosterEntryPath, parseHlsSessionData } from '../../shared/hls';
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

/**
 * HLS tar の master.m3u8 を R2 からレンジ読みし、EXT-X-SESSION-DATA のタイトル/ポスターを解決する。
 * HLS tar でない場合や master.m3u8 が見つからない場合は null。
 */
export async function getHlsTarMetadata(
	env: Env,
	db: ReturnType<typeof getDb>,
	file: Pick<typeof files.$inferSelect, 'id' | 'r2Key' | 'mimeType' | 'isTar'>,
): Promise<HlsTarMetadata | null> {
	if (file.mimeType !== HLS_TAR_MIME || !file.isTar) return null;
	const entries = await db
		.select({ path: tarFiles.path, offset: tarFiles.offset, size: tarFiles.size })
		.from(tarFiles)
		.where(eq(tarFiles.fileId, file.id))
		.all();
	const master = findHlsMasterEntry(entries);
	if (!master) return null;

	let title: string | null = null;
	let posterUri: string | null = null;
	if (master.size > 0 && master.size <= MAX_MASTER_PLAYLIST_BYTES) {
		const object = await env.R2.get(file.r2Key, { range: { offset: master.offset, length: master.size } });
		if (object) {
			const meta = parseHlsSessionData(await object.text());
			title = meta.title;
			posterUri = meta.posterUri;
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

	return { masterEntryPath: master.path, title, posterEntryPath };
}
