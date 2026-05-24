import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, and, gte, desc, sql, count, like } from 'drizzle-orm';
import { filetypemime } from 'magic-bytes.js';
import { apiError } from '../utils/api-error';
import { buckets, files, targzFiles, tarFiles, uploadParts, directories, tokens, users, fileAccessTokens, appSettings, DEFAULT_PART_SIZE, MIN_PART_SIZE } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser } from '../utils/rate-limit';
import { authMiddleware } from '../middleware/auth';
import { shortGetCache } from '../middleware/short-get-cache';
import { genEaidx } from '../../shared/eaid-x';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';
import { MAX_BUCKET_NAME_LENGTH, MAX_FILE_PATH_LENGTH, MAX_ID_LENGTH } from '../../shared/const';
import { detectExecutableMimeType, hasSuspiciousFileType, inferMimeTypeByExtension, isExecutableMimeType, looksLikeUtf8Text } from '../utils/mime-by-extension';
import { isValidDirectoryPath, isValidFilePath } from '../../shared/name-validation';
import { validateDirectoryPathForbiddenNames } from '../utils/name-validation';
import { findArchiveEntryPathConflict, hasFileDirectoryConflictForDirectory, hasFileDirectoryConflictForFile } from '../utils/path-conflicts';
import { fileMutationEvents } from '../events/file-mutations';
import { toFileMutationReference, toFileMutationReferences } from '../utils/file-mutation-reference';
import { recordModerationEvent } from '../utils/moderation';

const app = new Hono<{ Bindings: Env }>();

async function listFiles(c: { env: Env; req: { header(name: string): string | undefined } }, bucketName: string, path = '', forceOwner = false, allowBearerAuth = true) {
	const db = getDb(c.env);
	const normalizedPath = path === '' || path.endsWith('/') ? path : `${path}/`;
	const bucket = await db.select().from(buckets).where(eq(buckets.name, bucketName)).get();
	if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');

	let isOwnerOrAdmin = forceOwner;
	if (!isOwnerOrAdmin && allowBearerAuth) {
		const authorization = c.req.header('Authorization');
		if (authorization?.startsWith('Bearer ')) {
			const token = authorization.slice(7);
			const tokenRecord = await db
				.select({ userId: tokens.userId, isAdmin: users.isAdmin, isSuspended: users.isSuspended, isRevoked: tokens.isRevoked })
				.from(tokens)
				.innerJoin(users, eq(tokens.userId, users.id))
				.where(eq(tokens.token, token))
				.get();
			isOwnerOrAdmin = !!tokenRecord && !tokenRecord.isRevoked && !tokenRecord.isSuspended && (tokenRecord.isAdmin || tokenRecord.userId === bucket.userId);
		}
	}

	if (normalizedPath !== '') {
		const dirExists = await db.select({ id: directories.id, isListed: directories.isListed })
			.from(directories)
			.where(and(eq(directories.bucketId, bucket.id), eq(directories.path, normalizedPath)))
			.get();
		if (!isOwnerOrAdmin && dirExists && !dirExists.isListed) throw apiError(404, 'DIRECTORY_NOT_FOUND');
		if (!dirExists) {
			const hasFileCondition = isOwnerOrAdmin
				? and(eq(files.bucketId, bucket.id), like(files.path, `${normalizedPath}%`), eq(files.isClosed, true))
				: and(eq(files.bucketId, bucket.id), like(files.path, `${normalizedPath}%`), eq(files.isClosed, true), eq(files.visibility, 'public'), eq(files.isListed, true));
			const hasFile = await db.select({ path: files.path }).from(files).where(hasFileCondition).get();
			if (!hasFile) throw apiError(404, 'DIRECTORY_NOT_FOUND');
		}
	}

	const fileCondition = isOwnerOrAdmin
		? and(eq(files.bucketId, bucket.id), eq(files.isClosed, true))
		: and(eq(files.bucketId, bucket.id), eq(files.isClosed, true), eq(files.visibility, 'public'), eq(files.isListed, true));
	const allFiles = await db
		.select({
			id: files.id,
			path: files.path,
			size: files.size,
			mimeType: files.mimeType,
			isTargz: files.isTargz,
			isTar: files.isTar,
			visibility: files.visibility,
			isListed: files.isListed,
		})
		.from(files)
		.where(fileCondition);
	const allDirs = await db.select({ path: directories.path, isListed: directories.isListed }).from(directories).where(eq(directories.bucketId, bucket.id));
	const hiddenDirPaths = isOwnerOrAdmin ? new Set<string>() : new Set(allDirs.filter(dir => !dir.isListed).map(dir => dir.path));

	const entries: Array<{ type: 'dir' | 'file'; name: string; path?: string; fileId?: string; size?: number; mimeType?: string; isTargz?: boolean; isTar?: boolean; visibility?: 'public' | 'private' | 'passphrase'; isListed?: boolean }> = [];
	const seenDirs = new Set<string>();
	for (const d of allDirs) {
		if (!d.path.startsWith(normalizedPath)) continue;
		if (!isOwnerOrAdmin && !d.isListed) continue;
		const rest = d.path.slice(normalizedPath.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx !== -1) {
			const dirName = rest.slice(0, slashIdx);
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				entries.push({ type: 'dir', name: dirName, isListed: d.isListed });
			}
		}
	}
	for (const f of allFiles) {
		if (!f.path.startsWith(normalizedPath)) continue;
		const rest = f.path.slice(normalizedPath.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx === -1) {
			entries.push({ type: 'file', name: rest, path: f.path, fileId: f.id, size: f.size ?? undefined, mimeType: f.mimeType ?? undefined, isTargz: f.isTargz, isTar: f.isTar, visibility: f.visibility, ...(isOwnerOrAdmin ? { isListed: f.isListed } : {}) });
		} else {
			const dirName = rest.slice(0, slashIdx);
			if (hiddenDirPaths.has(`${normalizedPath}${dirName}/`)) continue;
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				const dir = allDirs.find(d => d.path === `${normalizedPath}${dirName}/`);
				entries.push({ type: 'dir', name: dirName, ...(isOwnerOrAdmin && dir ? { isListed: dir.isListed } : {}) });
			}
		}
	}
	entries.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
	return { type: 'directory' as const, entries };
}

async function shouldRejectMismatchedFileType(db: ReturnType<typeof getDb>): Promise<boolean> {
	const setting = await db
		.select({ value: appSettings.value })
		.from(appSettings)
		.where(eq(appSettings.key, 'reject_mismatched_file_type'))
		.get();
	return setting?.value === 'true';
}

app.use('/ls', shortGetCache({ maxAgeSeconds: 10 }));

app.get('/ls', async (c) => {
	const bucketName = c.req.query('bucketName');
	if (!bucketName) throw apiError(400, 'BUCKET_NAME_IS_REQUIRED');
	const path = c.req.query('path') ?? '';
	if (bucketName.length > MAX_BUCKET_NAME_LENGTH) throw apiError(400, 'BUCKET_NAME_IS_REQUIRED', `bucketName must be at most ${MAX_BUCKET_NAME_LENGTH} characters`);
	if (path.length > MAX_FILE_PATH_LENGTH) throw apiError(400, 'INVALID_FILE_PATH', `path must be at most ${MAX_FILE_PATH_LENGTH} characters`);
	return c.json(await listFiles(c, bucketName, path, false, false), 200);
});

app.get('/meta', async (c) => {
	const bucketName = c.req.query('bucketName');
	const path = c.req.query('path');
	const fileToken = c.req.query('token');
	if (!bucketName || path == null) throw apiError(400, 'BUCKET_NAME_IS_REQUIRED', 'bucketName and path are required');
	if (bucketName.length > MAX_BUCKET_NAME_LENGTH) throw apiError(400, 'BUCKET_NAME_IS_REQUIRED', `bucketName must be at most ${MAX_BUCKET_NAME_LENGTH} characters`);
	if (path.length > MAX_FILE_PATH_LENGTH) throw apiError(400, 'INVALID_FILE_PATH', `path must be at most ${MAX_FILE_PATH_LENGTH} characters`);
	if (fileToken && fileToken.length > MAX_ID_LENGTH) throw apiError(400, 'TOKEN_IS_REQUIRED', `token must be at most ${MAX_ID_LENGTH} characters`);

	const db = getDb(c.env);
	const bucket = await db.select().from(buckets).where(eq(buckets.name, bucketName)).get();
	if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');

	let isOwnerOrAdmin = false;
	let isOwner = false;
	const authorization = c.req.header('Authorization');
	if (authorization?.startsWith('Bearer ')) {
		const token = authorization.slice(7);
		const tokenRecord = await db
			.select({ userId: tokens.userId, isAdmin: users.isAdmin, isSuspended: users.isSuspended, isRevoked: tokens.isRevoked })
			.from(tokens)
			.innerJoin(users, eq(tokens.userId, users.id))
			.where(eq(tokens.token, token))
			.get();
		if (tokenRecord && !tokenRecord.isRevoked && !tokenRecord.isSuspended) {
			isOwner = tokenRecord.userId === bucket.userId;
			isOwnerOrAdmin = tokenRecord.isAdmin || isOwner;
		}
	}

	const file = await db
		.select()
		.from(files)
		.where(and(eq(files.bucketId, bucket.id), eq(files.path, path), eq(files.isClosed, true)))
		.get();
	if (!file) throw apiError(404, 'FILE_NOT_FOUND');

	const hasMimeMismatch = hasSuspiciousFileType(file.path, file.mimeType ?? undefined);
	const base = {
		visibility: file.visibility,
		isTargz: file.isTargz,
		isTar: file.isTar,
		size: file.size,
		mimeType: file.mimeType,
		extensionMimeType: inferMimeTypeByExtension(file.path),
		hasMimeTypeMismatch: hasMimeMismatch,
		hasExecutableContent: hasMimeMismatch && isExecutableMimeType(file.mimeType ?? undefined),
		isOwner,
	};
	if (file.visibility === 'public' || isOwnerOrAdmin) {
		return c.json({ ...base, fileId: file.id, bucketId: bucket.id, ...(isOwnerOrAdmin ? { isListed: file.isListed } : {}) });
	}
	if (fileToken) {
		const fileTokenRecord = await db
			.select()
			.from(fileAccessTokens)
			.where(and(eq(fileAccessTokens.token, fileToken), eq(fileAccessTokens.fileId, file.id)))
			.get();
		if (!fileTokenRecord) throw apiError(403, 'FORBIDDEN');
		if (fileTokenRecord.expiresAt !== null && fileTokenRecord.expiresAt < Date.now()) {
			throw apiError(403, 'FORBIDDEN');
		}
		return c.json({ ...base, fileId: file.id });
	}
	return c.json(base);
});

app.use(authMiddleware);

app.post(
	'/ls',
	describeRoute(omitResAndReq(apiDef['/api/files/ls'])),
	validator('json', apiDef['/api/files/ls'].req),
	describeResponse(async (c: JsonCtx<'/api/files/ls', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');
		const bucket = await db.select().from(buckets).where(eq(buckets.name, body.bucketName)).get();
		if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
		if (bucket.userId !== user.id && !user.isAdmin) throw apiError(403, 'FORBIDDEN');
		return c.json(await listFiles(c, body.bucketName, body.path ?? '', true), 200);
	}, getResponseDefWithAuth('/api/files/ls')),
);

app.post(
	'/create/open',
	describeRoute(omitResAndReq(apiDef['/api/files/create/open'])),
	validator('json', apiDef['/api/files/create/open'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/open', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.bucketId || !body.path) {
			throw apiError(400, 'INVALID_FILE_PATH', 'bucketId and path are required');
		}
		if (!isValidFilePath(body.path)) {
			throw apiError(400, 'INVALID_FILE_PATH');
		}

		const partSize = body.partSize ?? DEFAULT_PART_SIZE;
		if (partSize < MIN_PART_SIZE) {
			throw apiError(400, 'INVALID_FILE_PATH', `partSize must be at least ${MIN_PART_SIZE} bytes (5 MiB)`);
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, body.bucketId)).get();

		if (!bucket) {
			throw apiError(404, 'BUCKET_NOT_FOUND');
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw apiError(403, 'FORBIDDEN');
		}

		const existingFile = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, bucket.id), eq(files.path, body.path)))
			.get();

		if (existingFile && existingFile.isClosed) {
			throw apiError(409, 'FILE_ALREADY_EXISTS');
		}
		if (await hasFileDirectoryConflictForFile(db, bucket.id, body.path)) {
			throw apiError(409, 'TARGET_ALREADY_EXISTS');
		}

		const quota = await getQuotaForUser(c.env, user.id);

		if (quota.maxFilesPerBucket !== null) {
			const fileCount = await db
				.select()
				.from(files)
				.where(eq(files.bucketId, bucket.id))
				.then((result) => result.length);

			if (fileCount >= quota.maxFilesPerBucket) {
				throw apiError(429, 'FILE_LIMIT_EXCEEDED');
			}
		}

		if (quota.maxDailyUploads !== null) {
			const dayStart = Date.now() - 24 * 60 * 60 * 1000;
			const dailyUploadCount = await db
				.select()
				.from(files)
				.where(and(eq(files.userId, user.id), gte(files.id, genEaidx(dayStart))))
				.then((result) => result.length);

			if (dailyUploadCount >= quota.maxDailyUploads) {
				throw apiError(429, 'DAILY_UPLOAD_LIMIT_EXCEEDED');
			}
		}

		const fileId = genEaidx(Date.now());
		const r2Key = fileId;
		const uploadExpiry = Date.now() + 24 * 60 * 60 * 1000;

		await db.insert(files).values({
			id: fileId,
			bucketId: bucket.id,
			userId: user.id,
			path: body.path,
			r2Key,
			uploadExpiresAt: uploadExpiry,
			partSize,
		});

		return c.json({ fileId, uploadExpiry, partSize }, 200);
	}, getResponseDefWithAuth('/api/files/create/open')),
);

app.post(
	'/create/targz-index',
	describeRoute(omitResAndReq(apiDef['/api/files/create/targz-index'])),
	validator('json', apiDef['/api/files/create/targz-index'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/targz-index', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		const invalidEntry = body.files.find(entry => !isValidFilePath(entry.path));
		if (invalidEntry) {
			throw apiError(400, 'INVALID_FILE_PATH', `Invalid file path: ${invalidEntry.path}`);
		}
		const conflictEntryPath = findArchiveEntryPathConflict(body.files.map(entry => entry.path));
		if (conflictEntryPath !== null) {
			throw apiError(409, 'TARGET_ALREADY_EXISTS');
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();

		if (!file) {
			throw apiError(404, 'FILE_NOT_FOUND');
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();

		if (!bucket) {
			throw apiError(404, 'BUCKET_NOT_FOUND');
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw apiError(403, 'FORBIDDEN');
		}

		if (file.uploadExpiresAt < Date.now()) {
			throw apiError(410, 'UPLOAD_EXPIRED');
		}

		const fileIds = body.files.map(() => genEaidx(Date.now()));

		for (let i = 0; i < body.files.length; i++) {
			const entry = body.files[i];
			await db.insert(targzFiles).values({
				id: fileIds[i],
				fileId: file.id,
				path: entry.path,
				mimeType: entry.mimeType,
				aStart: entry.aStart,
				aFirstEnd: entry.aFirstEnd,
				aFinalStart: entry.aFinalStart,
				aEnd: entry.aEnd,
				rStartOffset: entry.rStartOffset,
				rEndOffset: entry.rEndOffset,
			});
		}

		await db.update(files).set({ isTargz: true }).where(eq(files.id, file.id));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/create/targz-index')),
);

app.post(
	'/create/tar-index',
	describeRoute(omitResAndReq(apiDef['/api/files/create/tar-index'])),
	validator('json', apiDef['/api/files/create/tar-index'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/tar-index', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		const invalidEntry = body.files.find(entry => !isValidFilePath(entry.path));
		if (invalidEntry) {
			throw apiError(400, 'INVALID_FILE_PATH', `Invalid file path: ${invalidEntry.path}`);
		}
		const conflictEntryPath = findArchiveEntryPathConflict(body.files.map(entry => entry.path));
		if (conflictEntryPath !== null) {
			throw apiError(409, 'TARGET_ALREADY_EXISTS');
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();
		if (!file) throw apiError(404, 'FILE_NOT_FOUND');

		const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();
		if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
		if (bucket.userId !== user.id && !user.isAdmin) throw apiError(403, 'FORBIDDEN');
		if (file.uploadExpiresAt < Date.now()) throw apiError(410, 'UPLOAD_EXPIRED');

		const fileIds = body.files.map(() => genEaidx(Date.now()));
		for (let i = 0; i < body.files.length; i++) {
			const entry = body.files[i];
			await db.insert(tarFiles).values({
				id: fileIds[i],
				fileId: file.id,
				path: entry.path,
				mimeType: entry.mimeType,
				offset: entry.offset,
				size: entry.size,
			});
		}

		await db.update(files).set({ isTar: true }).where(eq(files.id, file.id));

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/create/tar-index')),
);

app.post(
	'/create/close',
	describeRoute(omitResAndReq(apiDef['/api/files/create/close'])),
	validator('json', apiDef['/api/files/create/close'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/close', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.fileId) {
			throw apiError(400, 'FILE_ID_IS_REQUIRED');
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();

		if (!file) {
			throw apiError(404, 'FILE_NOT_FOUND');
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, file.bucketId)).get();

		if (!bucket) {
			throw apiError(404, 'BUCKET_NOT_FOUND');
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw apiError(403, 'FORBIDDEN');
		}

		if (file.uploadExpiresAt < Date.now()) {
			throw apiError(410, 'UPLOAD_EXPIRED');
		}

		const quota = await getQuotaForUser(c.env, user.id);

		if (file.uploadId) {
			const parts = await db
				.select()
				.from(uploadParts)
				.where(eq(uploadParts.fileId, file.id));

			if (parts.length === 0) {
				throw apiError(400, 'UPLOAD_HAS_NOT_BEEN_COMPLETED');
			}

			const sortedParts = parts
				.slice()
				.sort((a, b) => a.partNumber - b.partNumber)
				.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));

			const multipartUpload = c.env.R2.resumeMultipartUpload(file.r2Key, file.uploadId);
			try {
				await multipartUpload.complete(sortedParts);
			} catch (err) {
				console.error('Failed to complete multipart upload:', err);
				throw apiError(400, 'FAILED_TO_FINALIZE_UPLOAD');
			}

			await db.update(files).set({ uploadId: null }).where(eq(files.id, file.id));
		}

		let r2Object = await c.env.R2.head(file.r2Key);
		if (!r2Object) {
			const legacyR2Key = `${bucket.id}/${file.path}`;
			r2Object = await c.env.R2.head(legacyR2Key);
			if (r2Object) {
				await db.update(files).set({ r2Key: legacyR2Key }).where(eq(files.id, file.id));
				file.r2Key = legacyR2Key;
			}
		}

		if (!r2Object) {
			throw apiError(400, 'UPLOAD_HAS_NOT_BEEN_COMPLETED');
		}

		if (quota.maxBucketSizeBytes !== null) {
			if (bucket.usedBytes + r2Object.size > quota.maxBucketSizeBytes) {
				throw apiError(429, 'BUCKET_LIMIT_EXCEEDED');
			}
		}

		const fileSize = r2Object.size;

		let detectedMimeType: string | undefined;
		let headerBytes: Uint8Array | undefined;
		if (fileSize > 0) {
			try {
				const r2Slice = await c.env.R2.get(file.r2Key, { range: { offset: 0, length: 4100 } });
				if (r2Slice && 'bytes' in r2Slice) {
					headerBytes = await r2Slice.bytes();
					const magicMimeType = filetypemime(headerBytes)[0] ?? '';
					const magicLooksLikeText = magicMimeType.startsWith('text/');
					const usableMagicMimeType = magicMimeType === '' || magicMimeType === 'application/octet-stream' || (magicLooksLikeText && !looksLikeUtf8Text(headerBytes))
						? undefined
						: magicMimeType;
					detectedMimeType = detectExecutableMimeType(headerBytes) ?? usableMagicMimeType;
				}
			} catch {
				// fall back to client-provided content type
			}
		}
		const extensionMimeType = inferMimeTypeByExtension(file.path);
		const isUtf8Text = fileSize === 0 || (headerBytes ? looksLikeUtf8Text(headerBytes) : false);
		const mimeType = detectedMimeType ?? (isUtf8Text ? extensionMimeType : undefined) ?? (!isUtf8Text && extensionMimeType ? 'application/octet-stream' : undefined) ?? r2Object.httpMetadata?.contentType;
		const mismatch = hasSuspiciousFileType(file.path, mimeType);
		if (mismatch && await shouldRejectMismatchedFileType(db)) {
			throw apiError(400, 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION');
		}

		await db
			.update(files)
			.set({
				isClosed: true,
				visibility: body.visibility,
				isListed: body.isListed ?? true,
				passphrase: body.visibility === 'passphrase' ? (body.passphrase ?? null) : null,
				size: fileSize,
				mimeType,
			})
			.where(eq(files.id, file.id));

		await db
			.update(buckets)
			.set({ usedBytes: sql`${buckets.usedBytes} + ${fileSize}` })
			.where(eq(buckets.id, bucket.id));
		await recordModerationEvent(c, 'file_uploaded', {
			fileId: file.id,
			bucketId: bucket.id,
			bucketName: bucket.name,
			path: file.path,
			size: fileSize,
			mimeType,
		}, user.id, user.tokenId);

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/create/close')),
);

app.post(
	'/create/status',
	describeRoute(omitResAndReq(apiDef['/api/files/create/status'])),
	validator('json', apiDef['/api/files/create/status'].req),
	describeResponse(async (c: JsonCtx<'/api/files/create/status', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.fileId) {
			throw apiError(400, 'FILE_ID_IS_REQUIRED');
		}

		const file = await db.select().from(files).where(eq(files.id, body.fileId)).get();

		if (!file) {
			throw apiError(404, 'FILE_NOT_FOUND');
		}

		if (file.userId !== user.id && !user.isAdmin) {
			throw apiError(403, 'FORBIDDEN');
		}

		const [{ partCount }] = await db
			.select({ partCount: count() })
			.from(uploadParts)
			.where(eq(uploadParts.fileId, file.id));

		const partSize = file.partSize;
		return c.json({ partCount, offset: partCount * partSize, partSize }, 200);
	}, getResponseDefWithAuth('/api/files/create/status')),
);

app.post(
	'/update',
	describeRoute(omitResAndReq(apiDef['/api/files/update'])),
	validator('json', apiDef['/api/files/update'].req),
	describeResponse(async (c: JsonCtx<'/api/files/update', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.bucketName || !body.filePath) {
			throw apiError(400, 'BUCKET_NAME_IS_REQUIRED', 'bucketName and filePath are required');
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.name, body.bucketName)).get();
		if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
		if (bucket.userId !== user.id && !user.isAdmin) throw apiError(403, 'FORBIDDEN');

		const file = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, bucket.id), eq(files.path, body.filePath)))
			.get();
		if (!file) throw apiError(404, 'FILE_NOT_FOUND');
		if (!file.isClosed) throw apiError(400, 'FILE_IS_NOT_CLOSED');
		if (file.visibility === 'public' && body.visibility !== 'public') {
			throw apiError(400, 'PUBLIC_FILES_CANNOT_CHANGE_VISIBILITY');
		}

		await db
			.update(files)
			.set({
				visibility: body.visibility,
				isListed: body.isListed ?? file.isListed,
				passphrase: body.visibility === 'passphrase' ? (body.passphrase ?? null) : null,
			})
			.where(eq(files.id, file.id));

		fileMutationEvents.emit('file:updated', {
			env: c.env,
			origin: new URL(c.req.url).origin,
			waitUntil: promise => c.executionCtx.waitUntil(promise),
			bucket: { id: bucket.id, name: bucket.name },
			files: [await toFileMutationReference(db, file)],
		});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/update')),
);

app.post(
	'/update-listing',
	describeRoute(omitResAndReq(apiDef['/api/files/update-listing'])),
	validator('json', apiDef['/api/files/update-listing'].req),
	describeResponse(async (c: JsonCtx<'/api/files/update-listing', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.bucketId || body.targets.length === 0) {
			throw apiError(400, 'BUCKET_NOT_FOUND', 'bucketId and targets are required');
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, body.bucketId)).get();
		if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
		if (bucket.userId !== user.id && !user.isAdmin) throw apiError(403, 'FORBIDDEN');

		let matchedCount = 0;
		const filesToPurge = new Map<string, typeof files.$inferSelect>();
		for (const target of body.targets) {
			if (target.type === 'file') {
				const targetFiles = await db
					.select()
					.from(files)
					.where(and(eq(files.bucketId, bucket.id), eq(files.isClosed, true), eq(files.path, target.path)));
				const whereClauses = ['bucket_id = ?', 'is_closed = 1', 'path = ?'];
				const params: Array<string | number> = [bucket.id, target.path];
				const whereSql = whereClauses.join(' AND ');
				const countRow = await c.env.DB
					.prepare(`SELECT COUNT(*) AS count FROM files WHERE ${whereSql}`)
					.bind(...params)
					.first<{ count: number }>();
				const countForTarget = countRow?.count ?? 0;
				if (countForTarget === 0) continue;
				matchedCount += countForTarget;
				for (const file of targetFiles) filesToPurge.set(file.id, file);
				await c.env.DB
					.prepare(`UPDATE files SET is_listed = ? WHERE ${whereSql}`)
					.bind(body.isListed ? 1 : 0, ...params)
					.run();
				continue;
			}

			const prefix = target.path === '' || target.path.endsWith('/') ? target.path : `${target.path}/`;
			const excludePaths = target.excludePaths ?? [];
			const childFiles = await db
				.select()
				.from(files)
				.where(and(eq(files.bucketId, bucket.id), eq(files.isClosed, true), like(files.path, `${prefix}%`)));
			const whereClauses = ['bucket_id = ?', 'path LIKE ?'];
			const params: Array<string | number> = [bucket.id, `${prefix}%`];
			for (const excludedPath of excludePaths) {
				const normalizedExcludedPath = excludedPath.endsWith('/') ? excludedPath : `${excludedPath}/`;
				if (normalizedExcludedPath === prefix) {
					whereClauses.push('path != ?');
					params.push(normalizedExcludedPath);
				} else {
					whereClauses.push('path != ?', 'path NOT LIKE ?');
					params.push(normalizedExcludedPath, `${normalizedExcludedPath}%`);
				}
			}
			const whereSql = whereClauses.join(' AND ');
			const countRow = await c.env.DB
				.prepare(`SELECT COUNT(*) AS count FROM directories WHERE ${whereSql}`)
				.bind(...params)
				.first<{ count: number }>();
			const countForTarget = countRow?.count ?? 0;
			if (countForTarget === 0) {
				const targetDirectory = await db.select({ id: directories.id })
					.from(directories)
					.where(and(eq(directories.bucketId, bucket.id), eq(directories.path, prefix)))
					.get();
				if (!targetDirectory && excludePaths.length === 0) {
					await db.insert(directories).values({
						id: genEaidx(Date.now()),
						bucketId: bucket.id,
						path: prefix,
						isListed: body.isListed,
					}).onConflictDoNothing();
					matchedCount += 1;
					continue;
				}
			}
			if (countForTarget === 0) continue;
			matchedCount += countForTarget;
			for (const file of childFiles) {
				if (excludePaths.some((excludePath) => {
					const normalizedExcludedPath = excludePath.endsWith('/') ? excludePath : `${excludePath}/`;
					return file.path === normalizedExcludedPath || file.path.startsWith(normalizedExcludedPath);
				})) continue;
				filesToPurge.set(file.id, file);
			}
			await c.env.DB
				.prepare(`UPDATE directories SET is_listed = ? WHERE ${whereSql}`)
				.bind(body.isListed ? 1 : 0, ...params)
				.run();
		}

		if (matchedCount === 0) throw apiError(404, 'FILE_NOT_FOUND');

		const purgeFiles = await toFileMutationReferences(db, Array.from(filesToPurge.values()));
		if (purgeFiles.length > 0) {
			fileMutationEvents.emit('file:updated', {
				env: c.env,
				origin: new URL(c.req.url).origin,
				waitUntil: promise => c.executionCtx.waitUntil(promise),
				bucket: { id: bucket.id, name: bucket.name },
				files: purgeFiles,
			});
		}

		return c.json({ ok: true, updatedCount: matchedCount }, 200);
	}, getResponseDefWithAuth('/api/files/update-listing')),
);

app.post(
	'/uploadings',
	describeRoute(omitResAndReq(apiDef['/api/files/uploadings'])),
	validator('json', apiDef['/api/files/uploadings'].req),
	describeResponse(async (c: JsonCtx<'/api/files/uploadings', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');

		const userFiles = await db
			.select({
				id: files.id,
				bucketId: files.bucketId,
				bucketName: buckets.name,
				path: files.path,
				size: files.size,
				isClosed: files.isClosed,
				visibility: files.visibility,
				isListed: files.isListed,
				uploadExpiresAt: files.uploadExpiresAt,
				isTargz: files.isTargz,
				isTar: files.isTar,
			})
			.from(files)
			.innerJoin(buckets, eq(files.bucketId, buckets.id))
			.where(eq(files.userId, user.id))
			.orderBy(desc(files.id));

		return c.json({ files: userFiles }, 200);
	}, getResponseDefWithAuth('/api/files/uploadings')),
);

app.post(
	'/delete',
	describeRoute(omitResAndReq(apiDef['/api/files/delete'])),
	validator('json', apiDef['/api/files/delete'].req),
	describeResponse(async (c: JsonCtx<'/api/files/delete', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.bucketId) {
			throw apiError(400, 'BUCKET_NOT_FOUND', 'bucketId is required');
		}

		const bucket = await db.select().from(buckets).where(eq(buckets.id, body.bucketId)).get();

		if (!bucket) {
			throw apiError(404, 'BUCKET_NOT_FOUND');
		}

		if (bucket.userId !== user.id && !user.isAdmin) {
			throw apiError(403, 'FORBIDDEN');
		}

		const targets = body.targets ?? (body.path ? [{ type: 'file' as const, path: body.path }] : []);
		if (targets.length === 0) {
			throw apiError(400, 'PATH_OR_TARGETS_ARE_REQUIRED');
		}

		const filesToDelete = new Map<string, {
			id: string;
			r2Key: string;
			isClosed: boolean;
			size: number | null;
			path: string;
			isTar: boolean;
			isTargz: boolean;
		}>();
		const directoryPrefixes = new Set<string>();

		for (const target of targets) {
			if (target.type === 'file') {
				const file = await db
					.select()
					.from(files)
					.where(and(eq(files.bucketId, bucket.id), eq(files.path, target.path)))
					.get();
				if (!file) throw apiError(404, 'FILE_NOT_FOUND', `File not found: ${target.path}`);
				filesToDelete.set(file.id, file);
				continue;
			}

			const prefix = target.path === '' ? '' : target.path.endsWith('/') ? target.path : `${target.path}/`;
			const excludePaths = target.excludePaths ?? [];
			const childFiles = await db
				.select({ id: files.id, r2Key: files.r2Key, isClosed: files.isClosed, size: files.size, path: files.path, isTar: files.isTar, isTargz: files.isTargz })
				.from(files)
				.where(and(eq(files.bucketId, bucket.id), like(files.path, `${prefix}%`)));

			for (const file of childFiles) {
				if (excludePaths.some((excludePath) => {
					if (excludePath.endsWith('/')) return file.path.startsWith(excludePath);
					return file.path === excludePath;
				})) continue;
				filesToDelete.set(file.id, file);
			}

			if (excludePaths.length === 0) {
				directoryPrefixes.add(prefix);
			}
			const childDirectories = await db
				.select({ path: directories.path })
				.from(directories)
				.where(and(eq(directories.bucketId, bucket.id), like(directories.path, `${prefix}%`)));
			for (const dir of childDirectories) {
				if (excludePaths.some((excludePath) => {
					const normalizedExcludePath = excludePath.endsWith('/') ? excludePath : `${excludePath}/`;
					return dir.path === normalizedExcludePath || dir.path.startsWith(normalizedExcludePath) || normalizedExcludePath.startsWith(dir.path);
				})) continue;
				directoryPrefixes.add(dir.path);
			}
		}

		const purgeFiles = await toFileMutationReferences(db, Array.from(filesToDelete.values()));

		for (const file of filesToDelete.values()) {
			try {
				await c.env.R2.delete(file.r2Key);
			} catch (error) {
				console.error('Failed to delete R2 object:', file.r2Key, error);
			}
		}

		for (const file of filesToDelete.values()) {
			await db.delete(files).where(eq(files.id, file.id));
		}

		const sizeToDecrement = Array.from(filesToDelete.values()).reduce((sum, file) => sum + (file.isClosed && file.size ? file.size : 0), 0);
		if (sizeToDecrement > 0) {
			await db
				.update(buckets)
				.set({ usedBytes: sql`MAX(0, ${buckets.usedBytes} - ${sizeToDecrement})` })
				.where(eq(buckets.id, bucket.id));
		}

		for (const prefix of directoryPrefixes) {
			await db.delete(directories).where(and(eq(directories.bucketId, bucket.id), like(directories.path, `${prefix}%`)));
		}

		fileMutationEvents.emit('file:deleted', {
			env: c.env,
			origin: new URL(c.req.url).origin,
			waitUntil: promise => c.executionCtx.waitUntil(promise),
			bucket: { id: bucket.id, name: bucket.name },
			files: purgeFiles,
		});
		await recordModerationEvent(c, 'file_deleted', {
			bucketId: bucket.id,
			bucketName: bucket.name,
			targets,
			fileIds: Array.from(filesToDelete.keys()),
		}, user.id, user.tokenId);

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/delete')),
);

app.post(
	'/move',
	describeRoute(omitResAndReq(apiDef['/api/files/move'])),
	validator('json', apiDef['/api/files/move'].req),
	describeResponse(async (c: JsonCtx<'/api/files/move', Env>) => {
		const db = getDb(c.env);
		const user = c.get('user');
		const body = c.req.valid('json');

		if (!body.sourceBucketId || !body.targetBucketId || !body.sourcePath || !body.targetPath) {
			throw apiError(400, 'SOURCE_AND_TARGET_PATHS_ARE_REQUIRED');
		}

		const [sourceBucket, targetBucket] = await Promise.all([
			db.select().from(buckets).where(eq(buckets.id, body.sourceBucketId)).get(),
			db.select().from(buckets).where(eq(buckets.id, body.targetBucketId)).get(),
		]);
		if (!sourceBucket || !targetBucket) throw apiError(404, 'BUCKET_NOT_FOUND');
		if ((sourceBucket.userId !== user.id || targetBucket.userId !== user.id) && !user.isAdmin) {
			throw apiError(403, 'FORBIDDEN');
		}

		const normalizedSourcePath = body.type === 'directory'
			? body.sourcePath.endsWith('/') ? body.sourcePath : `${body.sourcePath}/`
			: body.sourcePath;
		const normalizedTargetPath = body.type === 'directory'
			? body.targetPath.endsWith('/') ? body.targetPath : `${body.targetPath}/`
			: body.targetPath;

		if (normalizedTargetPath.length > MAX_FILE_PATH_LENGTH) {
			throw apiError(400, 'INVALID_FILE_PATH', `targetPath must be at most ${MAX_FILE_PATH_LENGTH} characters`);
		}
		if (body.type === 'file' && !isValidFilePath(normalizedTargetPath)) {
			throw apiError(400, 'INVALID_FILE_PATH');
		}
		if (body.type === 'directory') {
			if (!isValidDirectoryPath(normalizedTargetPath)) {
				throw apiError(400, 'INVALID_DIRECTORY_PATH');
			}
			const directoryNameError = await validateDirectoryPathForbiddenNames(db, normalizedTargetPath);
			if (directoryNameError) throw apiError(400, 'INVALID_DIRECTORY_PATH', directoryNameError);
			if (body.sourceBucketId === body.targetBucketId && normalizedTargetPath.startsWith(normalizedSourcePath)) {
				throw apiError(400, 'DIRECTORY_CANNOT_BE_MOVED_INTO_ITSELF');
			}
		}

		if (body.sourceBucketId === body.targetBucketId && normalizedSourcePath === normalizedTargetPath) {
			return c.json({ ok: true }, 200);
		}

		const targetFilePath = body.type === 'directory' ? normalizedTargetPath.replace(/\/$/, '') : normalizedTargetPath;
		const targetDirectoryPath = body.type === 'directory'
			? normalizedTargetPath
			: `${normalizedTargetPath}/`;
		const targetFile = await db
			.select({ id: files.id })
			.from(files)
			.where(and(eq(files.bucketId, targetBucket.id), eq(files.path, targetFilePath)))
			.get();
		const targetDirectory = await db
			.select({ id: directories.id })
			.from(directories)
			.where(and(eq(directories.bucketId, targetBucket.id), eq(directories.path, targetDirectoryPath)))
			.get();
		const targetVirtualDirectoryFile = body.type === 'directory'
			? await db
				.select({ id: files.id })
				.from(files)
				.where(and(eq(files.bucketId, targetBucket.id), like(files.path, `${normalizedTargetPath}%`)))
				.get()
			: null;
		if (targetFile || targetDirectory || targetVirtualDirectoryFile) {
			throw apiError(409, 'TARGET_ALREADY_EXISTS');
		}
		const hasTargetConflict = body.type === 'directory'
			? await hasFileDirectoryConflictForDirectory(db, targetBucket.id, normalizedTargetPath)
			: await hasFileDirectoryConflictForFile(db, targetBucket.id, normalizedTargetPath);
		if (hasTargetConflict) {
			throw apiError(409, 'TARGET_ALREADY_EXISTS');
		}

		if (body.type === 'file') {
			const file = await db
				.select()
				.from(files)
				.where(and(eq(files.bucketId, sourceBucket.id), eq(files.path, normalizedSourcePath)))
				.get();
			if (!file) throw apiError(404, 'FILE_NOT_FOUND');
			if (!file.isClosed) throw apiError(400, 'FILE_IS_NOT_CLOSED');

			const movedBytes = file.size ?? 0;
			if (hasSuspiciousFileType(normalizedTargetPath, file.mimeType ?? undefined) && await shouldRejectMismatchedFileType(db)) {
				throw apiError(400, 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION');
			}
			if (sourceBucket.id !== targetBucket.id && movedBytes > 0) {
				const quota = await getQuotaForUser(c.env, targetBucket.userId);
				if (quota.maxBucketSizeBytes !== null && targetBucket.usedBytes + movedBytes > quota.maxBucketSizeBytes) {
					throw apiError(429, 'TARGET_BUCKET_SIZE_LIMIT_EXCEEDED');
				}
			}

			await db
				.update(files)
				.set({ bucketId: targetBucket.id, path: normalizedTargetPath })
				.where(eq(files.id, file.id));

			if (sourceBucket.id !== targetBucket.id && movedBytes > 0) {
				await db.update(buckets).set({ usedBytes: sql`MAX(0, ${buckets.usedBytes} - ${movedBytes})` }).where(eq(buckets.id, sourceBucket.id));
				await db.update(buckets).set({ usedBytes: sql`${buckets.usedBytes} + ${movedBytes}` }).where(eq(buckets.id, targetBucket.id));
			}

			fileMutationEvents.emit('file:moved', {
				env: c.env,
				origin: new URL(c.req.url).origin,
				waitUntil: promise => c.executionCtx.waitUntil(promise),
				sourceBucket: { id: sourceBucket.id, name: sourceBucket.name },
				targetBucket: { id: targetBucket.id, name: targetBucket.name },
				files: [{ ...await toFileMutationReference(db, { ...file, path: normalizedSourcePath }), nextPath: normalizedTargetPath }],
			});
			await recordModerationEvent(c, 'file_renamed', {
				fileId: file.id,
				sourceBucketId: sourceBucket.id,
				targetBucketId: targetBucket.id,
				sourcePath: normalizedSourcePath,
				targetPath: normalizedTargetPath,
			}, user.id, user.tokenId);

			return c.json({ ok: true }, 200);
		}

		const sourceDirectory = await db
			.select()
			.from(directories)
			.where(and(eq(directories.bucketId, sourceBucket.id), eq(directories.path, normalizedSourcePath)))
			.get();
		const childFiles = await db
			.select()
			.from(files)
			.where(and(eq(files.bucketId, sourceBucket.id), like(files.path, `${normalizedSourcePath}%`)));
		const childDirectories = await db
			.select()
			.from(directories)
			.where(and(eq(directories.bucketId, sourceBucket.id), like(directories.path, `${normalizedSourcePath}%`)));
		if (!sourceDirectory && childFiles.length === 0 && childDirectories.length === 0) {
			throw apiError(404, 'DIRECTORY_NOT_FOUND');
		}

		const movedBytes = childFiles.reduce((sum, file) => sum + (file.isClosed && file.size ? file.size : 0), 0);
		if (sourceBucket.id !== targetBucket.id && movedBytes > 0) {
			const quota = await getQuotaForUser(c.env, targetBucket.userId);
			if (quota.maxBucketSizeBytes !== null && targetBucket.usedBytes + movedBytes > quota.maxBucketSizeBytes) {
				throw apiError(429, 'TARGET_BUCKET_SIZE_LIMIT_EXCEEDED');
			}
		}

		for (const file of childFiles) {
			await db
				.update(files)
				.set({
					bucketId: targetBucket.id,
					path: `${normalizedTargetPath}${file.path.slice(normalizedSourcePath.length)}`,
				})
				.where(eq(files.id, file.id));
		}
		for (const directory of childDirectories) {
			await db
				.update(directories)
				.set({
					bucketId: targetBucket.id,
					path: `${normalizedTargetPath}${directory.path.slice(normalizedSourcePath.length)}`,
				})
				.where(eq(directories.id, directory.id));
		}
		if (!childDirectories.some(directory => directory.path === normalizedSourcePath)) {
			await db.insert(directories).values({
				id: genEaidx(Date.now()),
				bucketId: targetBucket.id,
				path: normalizedTargetPath,
				isListed: sourceDirectory?.isListed ?? true,
			}).onConflictDoNothing();
		}

		if (sourceBucket.id !== targetBucket.id && movedBytes > 0) {
			await db.update(buckets).set({ usedBytes: sql`MAX(0, ${buckets.usedBytes} - ${movedBytes})` }).where(eq(buckets.id, sourceBucket.id));
			await db.update(buckets).set({ usedBytes: sql`${buckets.usedBytes} + ${movedBytes}` }).where(eq(buckets.id, targetBucket.id));
		}

		fileMutationEvents.emit('directory:moved', {
			env: c.env,
			origin: new URL(c.req.url).origin,
			waitUntil: promise => c.executionCtx.waitUntil(promise),
			sourceBucket: { id: sourceBucket.id, name: sourceBucket.name },
			targetBucket: { id: targetBucket.id, name: targetBucket.name },
			sourcePrefix: normalizedSourcePath,
			targetPrefix: normalizedTargetPath,
			files: (await toFileMutationReferences(db, childFiles)).map(file => ({
				...file,
				nextPath: `${normalizedTargetPath}${file.path.slice(normalizedSourcePath.length)}`,
			})),
		});

		return c.json({ ok: true }, 200);
	}, getResponseDefWithAuth('/api/files/move')),
);

export const fileRoutes = app;
