import { eq } from 'drizzle-orm';
import { buckets, files } from '../scheme/index';
import { getDb } from './db';
import { apiError } from './api-error';

/** 公開状態（public + listed + closed + モデレーション非適用）のファイルとバケットを取得する */
export async function getPublicFile(db: ReturnType<typeof getDb>, fileId: string): Promise<{ file: typeof files.$inferSelect; bucket: typeof buckets.$inferSelect }> {
	const file = await db.select().from(files).where(eq(files.id, fileId)).get();
	if (!file || !file.isClosed || file.visibility !== 'public' || !file.isListed || file.isModerationForcedPrivate) throw apiError(404, 'FILE_NOT_FOUND');
	const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();
	if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
	return { file, bucket };
}
