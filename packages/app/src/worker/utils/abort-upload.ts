import { eq } from 'drizzle-orm';
import { files, uploadParts } from '../scheme/index';
import { getDb } from './db';

type File = typeof files.$inferSelect;

export async function abortUpload(file: File, env: Env): Promise<void> {
	const db = getDb(env);

	if (file.uploadId) {
		try {
			await env.R2.resumeMultipartUpload(file.r2Key, file.uploadId).abort();
		} catch (err) {
			console.error('Failed to abort multipart upload:', file.r2Key, err);
		}
	}

	try {
		await env.R2.delete(file.r2Key);
	} catch (err) {
		console.error('Failed to delete R2 object during abort:', file.r2Key, err);
	}

	await db.delete(uploadParts).where(eq(uploadParts.fileId, file.id));
	await db.delete(files).where(eq(files.id, file.id));
}
