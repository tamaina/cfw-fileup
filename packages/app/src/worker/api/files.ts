import { Hono } from 'hono';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq, and, gte, desc, sql, count, lt, lte, ne, type SQL } from 'drizzle-orm';
import { apiError } from '../utils/api-error';
import { buckets, files, targzFiles, tarFiles, uploadParts, directories, tokens, users, fileAccessTokens, DEFAULT_PART_SIZE, MIN_PART_SIZE } from '../scheme/index';
import { getDb } from '../utils/db';
import { getQuotaForUser } from '../utils/rate-limit';
import { authMiddleware } from '../middleware/auth';
import { shortGetCache } from '../middleware/short-get-cache';
import { genEaidx } from '../../shared/eaid-x';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { HLS_TAR_MIME } from '../../shared/hls';
import { omitResAndReq } from '../utils/omit';
import { MAX_BUCKET_NAME_LENGTH, MAX_FILE_PATH_LENGTH, MAX_ID_LENGTH } from '../../shared/const';
import { hasSuspiciousFileType, inferMimeTypeByExtension, isExecutableMimeType, selectStoredOrSniffedMimeType } from '../utils/mime-by-extension';
import { isValidDirectoryPath, isValidFilePath } from '../../shared/name-validation';
import { validateDirectoryPathForbiddenNames } from '../utils/name-validation';
import { findArchiveEntryPathConflict, hasFileDirectoryConflictForDirectory, hasFileDirectoryConflictForFile } from '../utils/path-conflicts';
import { fileMutationEvents } from '../events/file-mutations';
import { toFileMutationReference, toFileMutationReferences } from '../utils/file-mutation-reference';
import { recordModerationAuditLog, recordModerationEvent } from '../utils/moderation';
import { hashPassword, tokenToDigest } from '../utils/crypto';
import { pageParams, type PageInput } from '../utils/pagination';
import { likePrefix, notLikePrefix, prefixLikePattern } from '../utils/sql-like';
import { ensureAncestorDirectories } from '../utils/ensure-ancestor-directories';
import { assertValidTarIndexEntry, assertValidTargzIndexEntry } from '../utils/archive-index-validation';
import { getAppSettingCached } from '../utils/app-settings-cache';

const app = new Hono<{ Bindings: Env }>();

type FileListEntry = {
	type: 'dir' | 'file';
	name: string;
	path?: string;
	fileId?: string;
	size?: number;
	mimeType?: string;
	isTargz?: boolean;
	isTar?: boolean;
	isEncrypted?: boolean;
	visibility?: 'public' | 'private' | 'passphrase';
	isListed?: boolean;
	isModerationForcedPrivate?: boolean;
	downloadCount?: number;
	isDownloadCountEnabled?: boolean;
	isDownloadCountVisible?: boolean;
};

type FileListCursor = {
	type: 'dir' | 'file';
	name: string;
	key: string;
};

type RawFileListEntry = {
	sort_type: number;
	type: 'dir' | 'file';
	name: string;
	key: string;
	path: string | null;
	fileId: string | null;
	size: number | null;
	mimeType: string | null;
	isTargz: number | null;
	isTar: number | null;
	isEncrypted: number | null;
	visibility: 'public' | 'private' | 'passphrase' | null;
	isListed: number | null;
	isModerationForcedPrivate: number | null;
	downloadCount: number | null;
	isDownloadCountEnabled: number | null;
	isDownloadCountVisible: number | null;
};

function encodeCursor(cursor: FileListCursor): string {
	const bytes = new TextEncoder().encode(JSON.stringify(cursor));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string | null): FileListCursor | null {
	if (!cursor) return null;
	try {
		const padded = cursor.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(cursor.length / 4) * 4, '=');
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
		const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<FileListCursor>;
		if ((value.type === 'dir' || value.type === 'file') && typeof value.name === 'string' && typeof value.key === 'string') {
			return { type: value.type, name: value.name, key: value.key };
		}
	} catch {
		// Invalid cursors simply behave like the first page.
	}
	return null;
}

async function listFiles(c: { env: Env; req: { header(name: string): string | undefined } }, bucketName: string, path = '', forceOwner = false, allowBearerAuth = true, pageInput: PageInput = {}) {
	const db = getDb(c.env);
	const normalizedPath = path === '' || path.endsWith('/') ? path : `${path}/`;
	const bucket = await db.select().from(buckets).where(eq(buckets.name, bucketName)).get();
	if (!bucket) throw apiError(404, 'BUCKET_NOT_FOUND');
	const ownerQuota = await getQuotaForUser(c.env, bucket.userId);

	let isOwnerOrAdmin = forceOwner;
	if (!isOwnerOrAdmin && allowBearerAuth) {
		const authorization = c.req.header('Authorization');
		if (authorization?.startsWith('Bearer ')) {
			const token = authorization.slice(7);
			const tokenBytes = await tokenToDigest(token);
			const tokenRecord = await db
				.select({ userId: tokens.userId, isAdmin: users.isAdmin, isSuspended: users.isSuspended, isRevoked: tokens.isRevoked })
				.from(tokens)
				.innerJoin(users, eq(tokens.userId, users.id))
				.where(tokenBytes === null ? sql`false` : eq(tokens.token, tokenBytes))
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
				? and(eq(files.bucketId, bucket.id), likePrefix(files.path, normalizedPath), eq(files.isClosed, true))
				: and(eq(files.bucketId, bucket.id), likePrefix(files.path, normalizedPath), eq(files.isClosed, true), eq(files.visibility, 'public'), eq(files.isListed, true), eq(files.isModerationForcedPrivate, false));
			const hasFile = await db.select({ path: files.path }).from(files).where(hasFileCondition).get();
			if (!hasFile) throw apiError(404, 'DIRECTORY_NOT_FOUND');
		}
	}

	const { limit, cursor } = pageParams(pageInput);
	const decodedCursor = decodeCursor(cursor);
	const cursorSortType = decodedCursor?.type === 'file' ? 1 : decodedCursor?.type === 'dir' ? 0 : null;
	const cursorName = decodedCursor?.name ?? null;
	const cursorKey = decodedCursor?.key ?? null;
	const prefixLike = prefixLikePattern(normalizedPath);
	const childStart = normalizedPath.length + 1;
	const ownerVisibilitySql = isOwnerOrAdmin
		? '1 = 1'
		: `NOT EXISTS (
			SELECT 1 FROM directories hidden
			WHERE hidden.bucket_id = ?
				AND hidden.is_listed = 0
					AND substr(candidate_path, 1, length(hidden.path)) = hidden.path
		)`;
	const publicExtraBind = isOwnerOrAdmin ? [] : [bucket.id];
	const sqlText = `
		WITH
		directory_candidates AS (
			SELECT
				0 AS sort_type,
				'dir' AS type,
				CASE
					WHEN instr(substr(path, ?), '/') = 0 THEN substr(path, ?)
					ELSE substr(substr(path, ?), 1, instr(substr(path, ?), '/') - 1)
				END AS name,
				path AS candidate_path,
				path AS key,
				NULL AS file_id,
				NULL AS size,
				NULL AS mime_type,
				NULL AS is_targz,
				NULL AS is_tar,
				NULL AS is_encrypted,
				NULL AS visibility,
				is_listed AS is_listed,
				NULL AS is_moderation_forced_private,
				NULL AS download_count,
				NULL AS is_download_count_enabled,
				NULL AS is_download_count_visible
			FROM directories
			WHERE bucket_id = ?
				AND path LIKE ? ESCAPE '\\'
				AND path != ?
				${isOwnerOrAdmin ? '' : 'AND is_listed = 1'}
		),
		file_candidates AS (
			SELECT
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN 1 ELSE 0 END AS sort_type,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN 'file' ELSE 'dir' END AS type,
				CASE
					WHEN instr(substr(path, ?), '/') = 0 THEN substr(path, ?)
					ELSE substr(substr(path, ?), 1, instr(substr(path, ?), '/') - 1)
				END AS name,
				path AS candidate_path,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN id ELSE substr(path, 1, ? + length(
					substr(substr(path, ?), 1, instr(substr(path, ?), '/') - 1)
				) + 1) END AS key,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN id ELSE NULL END AS file_id,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN size ELSE NULL END AS size,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN mime_type ELSE NULL END AS mime_type,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN is_targz ELSE NULL END AS is_targz,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN is_tar ELSE NULL END AS is_tar,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN is_encrypted ELSE NULL END AS is_encrypted,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN visibility ELSE NULL END AS visibility,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN is_listed ELSE NULL END AS is_listed,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN is_moderation_forced_private ELSE NULL END AS is_moderation_forced_private,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN download_count ELSE NULL END AS download_count,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN is_download_count_enabled ELSE NULL END AS is_download_count_enabled,
				CASE WHEN instr(substr(path, ?), '/') = 0 THEN is_download_count_visible ELSE NULL END AS is_download_count_visible
			FROM files
			WHERE bucket_id = ?
				AND is_closed = 1
				AND path LIKE ? ESCAPE '\\'
				AND path != ?
				${isOwnerOrAdmin ? '' : 'AND visibility = \'public\' AND is_listed = 1 AND is_moderation_forced_private = 0'}
		),
		visible_file_candidates AS (
			SELECT * FROM file_candidates
			WHERE ${ownerVisibilitySql}
		),
		combined AS (
			SELECT * FROM directory_candidates
			UNION ALL
			SELECT * FROM visible_file_candidates
		),
		grouped AS (
			SELECT
				sort_type,
				type,
				name,
				min(key) AS key,
				max(file_id) AS fileId,
				max(candidate_path) AS path,
				max(size) AS size,
				max(mime_type) AS mimeType,
				max(is_targz) AS isTargz,
				max(is_tar) AS isTar,
				max(is_encrypted) AS isEncrypted,
				max(visibility) AS visibility,
				max(is_listed) AS isListed,
				max(is_moderation_forced_private) AS isModerationForcedPrivate,
				max(download_count) AS downloadCount,
				max(is_download_count_enabled) AS isDownloadCountEnabled,
				max(is_download_count_visible) AS isDownloadCountVisible
			FROM combined
			WHERE name != ''
			GROUP BY sort_type, type, name
		)
		SELECT * FROM grouped
		WHERE (? IS NULL OR sort_type > ? OR (sort_type = ? AND (name > ? OR (name = ? AND key > ?))))
		ORDER BY sort_type ASC, name ASC, key ASC
		LIMIT ?
	`;
	const restArgs = [
		childStart, childStart, childStart, childStart,
		bucket.id, prefixLike, normalizedPath,
		childStart, childStart, childStart, childStart, childStart, childStart,
		childStart, normalizedPath.length, childStart, childStart,
		childStart, childStart, childStart, childStart, childStart, childStart, childStart,
		childStart, childStart, childStart, childStart, childStart,
		bucket.id, prefixLike, normalizedPath,
		...publicExtraBind,
		cursorSortType, cursorSortType, cursorSortType, cursorName, cursorName, cursorKey,
		limit + 1,
	];
	const rows = (await c.env.DB.prepare(sqlText).bind(...restArgs).all<RawFileListEntry>()).results;
	const pageRows = rows.slice(0, limit);
	const items = pageRows.map((row): FileListEntry => {
		if (row.type === 'dir') {
			return {
				type: 'dir',
				name: row.name,
				...(isOwnerOrAdmin && row.isListed !== null ? { isListed: !!row.isListed } : {}),
			};
		}
		return {
			type: 'file',
			name: row.name,
			path: row.path ?? undefined,
			fileId: row.fileId ?? undefined,
			size: row.size ?? undefined,
			mimeType: row.mimeType ?? undefined,
			isTargz: !!row.isTargz,
			isTar: !!row.isTar,
			isEncrypted: !!row.isEncrypted,
			visibility: row.visibility ?? undefined,
			...((row.isDownloadCountEnabled && (isOwnerOrAdmin || row.isDownloadCountVisible)) ? { downloadCount: row.downloadCount ?? 0 } : {}),
			...(isOwnerOrAdmin
				? {
					isListed: !!row.isListed,
					isModerationForcedPrivate: !!row.isModerationForcedPrivate,
					isDownloadCountEnabled: !!row.isDownloadCountEnabled,
					isDownloadCountVisible: !!row.isDownloadCountVisible,
				}
				: {}),
		};
	});
	const lastRow = pageRows.at(-1);
	return {
		type: 'directory' as const,
		items,
		nextCursor: rows.length > limit && lastRow ? encodeCursor({ type: lastRow.type, name: lastRow.name, key: lastRow.key }) : null,
		hasMore: rows.length > limit,
		ownerCanDisableFileAds: ownerQuota.canDisableFileAds,
	};
}

async function shouldRejectMismatchedFileType(env: Env): Promise<boolean> {
	return await getAppSettingCached(env, 'reject_mismatched_file_type') === 'true';
}

async function validateArchiveIndexRows(db: ReturnType<typeof getDb>, fileId: string, fileSize: number): Promise<void> {
	const [tarIndexRows, targzIndexRows] = await Promise.all([
		db.select().from(tarFiles).where(eq(tarFiles.fileId, fileId)),
		db.select().from(targzFiles).where(eq(targzFiles.fileId, fileId)),
	]);
	try {
		for (const entry of tarIndexRows) assertValidTarIndexEntry(entry, fileSize);
		for (const entry of targzIndexRows) assertValidTargzIndexEntry(entry, fileSize);
	} catch (error) {
		await Promise.all([
			db.delete(tarFiles).where(eq(tarFiles.fileId, fileId)),
			db.delete(targzFiles).where(eq(targzFiles.fileId, fileId)),
		]);
		await db.update(files).set({ isTar: false, isTargz: false }).where(eq(files.id, fileId));
		throw error;
	}
}

app.use('/ls', shortGetCache({ maxAgeSeconds: 10 }));

app.get('/ls', async (c) => {
	const bucketName = c.req.query('bucketName');
	if (!bucketName) throw apiError(400, 'BUCKET_NAME_IS_REQUIRED');
	const path = c.req.query('path') ?? '';
	const limit = c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit'));
	const cursor = c.req.query('cursor') ?? null;
	if (bucketName.length > MAX_BUCKET_NAME_LENGTH) throw apiError(400, 'BUCKET_NAME_IS_REQUIRED', `bucketName must be at most ${MAX_BUCKET_NAME_LENGTH} characters`);
	if (path.length > MAX_FILE_PATH_LENGTH) throw apiError(400, 'INVALID_FILE_PATH', `path must be at most ${MAX_FILE_PATH_LENGTH} characters`);
	return c.json(await listFiles(c, bucketName, path, false, false, { limit, cursor }), 200);
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
		const tokenBytes = await tokenToDigest(token);
		const tokenRecord = await db
			.select({ userId: tokens.userId, isAdmin: users.isAdmin, isSuspended: users.isSuspended, isRevoked: tokens.isRevoked })
			.from(tokens)
			.innerJoin(users, eq(tokens.userId, users.id))
			.where(tokenBytes === null ? sql`false` : eq(tokens.token, tokenBytes))
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
	const ownerQuota = await getQuotaForUser(c.env, file.userId);
	const base = {
		visibility: file.visibility,
		isModerationForcedPrivate: file.isModerationForcedPrivate,
		isTargz: file.isTargz,
		isTar: file.isTar,
		isEncrypted: file.isEncrypted,
		size: file.size,
		mimeType: file.mimeType,
		extensionMimeType: inferMimeTypeByExtension(file.path),
		hasMimeTypeMismatch: hasMimeMismatch,
		hasExecutableContent: hasMimeMismatch && isExecutableMimeType(file.mimeType ?? undefined),
		isOwner,
		ownerCanDisableFileAds: ownerQuota.canDisableFileAds,
		...((file.isDownloadCountEnabled && (isOwnerOrAdmin || file.isDownloadCountVisible)) ? { downloadCount: file.downloadCount } : {}),
	};
	if ((file.visibility === 'public' && !file.isModerationForcedPrivate) || isOwnerOrAdmin) {
		return c.json({
			...base,
			fileId: file.id,
			bucketId: bucket.id,
			...(isOwnerOrAdmin
				? {
					isListed: file.isListed,
					isDownloadCountEnabled: file.isDownloadCountEnabled,
					isDownloadCountVisible: file.isDownloadCountVisible,
					canUseDownloadCount: ownerQuota.canUseDownloadCount,
				}
				: {}),
		});
	}
	if (fileToken) {
		const fileTokenBytes = await tokenToDigest(fileToken);
		const fileTokenRecord = await db
			.select()
			.from(fileAccessTokens)
			.where(and(fileTokenBytes === null ? sql`false` : eq(fileAccessTokens.token, fileTokenBytes), eq(fileAccessTokens.fileId, file.id)))
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
		return c.json(await listFiles(c, body.bucketName, body.path ?? '', true, true, body), 200);
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
			const [{ fileCount }] = await db
				.select({ fileCount: count() })
				.from(files)
				.where(eq(files.bucketId, bucket.id));

			if (fileCount >= quota.maxFilesPerBucket) {
				throw apiError(429, 'FILE_LIMIT_EXCEEDED');
			}
		}

		if (quota.maxDailyUploads !== null) {
			const dayStart = Date.now() - 24 * 60 * 60 * 1000;
			const [{ dailyUploadCount }] = await db
				.select({ dailyUploadCount: count() })
				.from(files)
				.where(and(eq(files.userId, user.id), gte(files.id, genEaidx(dayStart))));

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
		const r2Object = await c.env.R2.head(file.r2Key);
		if (r2Object) {
			for (const entry of body.files) assertValidTargzIndexEntry(entry, r2Object.size);
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
		const r2Object = await c.env.R2.head(file.r2Key);
		if (r2Object) {
			for (const entry of body.files) assertValidTarIndexEntry(entry, r2Object.size);
		}

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

		if (body.isDownloadCountEnabled && !quota.canUseDownloadCount) {
			throw apiError(403, 'FORBIDDEN');
		}
		const isDownloadCountEnabled = body.isDownloadCountEnabled ?? false;
		const isDownloadCountVisible = isDownloadCountEnabled ? body.isDownloadCountVisible ?? false : false;

		const fileSize = r2Object.size;
		await validateArchiveIndexRows(db, file.id, fileSize);

		const isEncrypted = body.isEncrypted ?? false;

		let detectedMimeType: string | undefined;
		let headerBytes: Uint8Array | undefined;
		// Skip MIME sniffing for encrypted files — content is opaque to the server
		if (!isEncrypted && fileSize > 0) {
			try {
				const r2Slice = await c.env.R2.get(file.r2Key, { range: { offset: 0, length: 4100 } });
				if (r2Slice && 'bytes' in r2Slice) {
					headerBytes = await r2Slice.bytes();
				}
			} catch {
				// fall back to client-provided content type
			}
		}
		if (!isEncrypted && (headerBytes !== undefined || fileSize === 0)) {
			detectedMimeType = selectStoredOrSniffedMimeType({
				path: file.path,
				sniffBytes: headerBytes ?? new Uint8Array(0),
				fallbackMimeType: r2Object.httpMetadata?.contentType,
			});
		}
		const requestedMimeType = body.mimeType === HLS_TAR_MIME ? body.mimeType : undefined;
		const mimeType = isEncrypted
			? (body.mimeType ?? 'application/octet-stream')
			: (requestedMimeType ?? detectedMimeType ?? r2Object.httpMetadata?.contentType);
		const mismatch = isEncrypted ? false : hasSuspiciousFileType(file.path, mimeType);
		if (mismatch && await shouldRejectMismatchedFileType(c.env)) {
			throw apiError(400, 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION');
		}

		const updateBucket = db.update(buckets)
			.set({ usedBytes: sql`${buckets.usedBytes} + ${fileSize}` })
			.where(quota.maxBucketSizeBytes !== null
				? and(eq(buckets.id, bucket.id), lte(sql`${buckets.usedBytes} + ${fileSize}`, quota.maxBucketSizeBytes))
				: eq(buckets.id, bucket.id))
			.returning({ id: buckets.id });
		const updateFile = db.update(files)
			.set({
				isClosed: true,
				visibility: body.visibility,
				isListed: body.isListed ?? true,
				passphraseHash: body.visibility === 'passphrase' && body.passphrase ? await hashPassword(body.passphrase) : null,
				isDownloadCountEnabled,
				isDownloadCountVisible,
				isEncrypted,
				size: fileSize,
				mimeType,
			})
			.where(and(eq(files.id, file.id), eq(files.isClosed, false)))
			.returning({ id: files.id });
		const [updatedBuckets, updatedFiles] = await db.batch([updateBucket, updateFile]);
		if (updatedBuckets.length === 0) {
			throw quota.maxBucketSizeBytes !== null
				? apiError(429, 'BUCKET_LIMIT_EXCEEDED')
				: apiError(404, 'BUCKET_NOT_FOUND');
		}
		if (updatedFiles.length === 0) {
			throw apiError(409, 'FILE_ALREADY_EXISTS');
		}
		await ensureAncestorDirectories(db, bucket.id, file.path);
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
		const nextDownloadCountEnabled = body.isDownloadCountEnabled ?? file.isDownloadCountEnabled;
		if (nextDownloadCountEnabled && !file.isDownloadCountEnabled) {
			const quota = await getQuotaForUser(c.env, file.userId);
			if (!quota.canUseDownloadCount) throw apiError(403, 'FORBIDDEN');
		}
		const nextDownloadCountVisible = nextDownloadCountEnabled
			? body.isDownloadCountVisible ?? file.isDownloadCountVisible
			: false;

		await db
			.update(files)
			.set({
				visibility: body.visibility,
				isListed: body.isListed ?? file.isListed,
				passphraseHash: body.visibility === 'passphrase' && body.passphrase ? await hashPassword(body.passphrase) : null,
				isDownloadCountEnabled: nextDownloadCountEnabled,
				isDownloadCountVisible: nextDownloadCountVisible,
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
				if (targetFiles.length === 0) continue;
				matchedCount += targetFiles.length;
				for (const file of targetFiles) filesToPurge.set(file.id, file);
				await db.update(files)
					.set({ isListed: body.isListed })
					.where(and(eq(files.bucketId, bucket.id), eq(files.isClosed, true), eq(files.path, target.path)));
				continue;
			}

			const prefix = target.path === '' || target.path.endsWith('/') ? target.path : `${target.path}/`;
			const excludePaths = target.excludePaths ?? [];

			const fileConditions: (SQL | undefined)[] = [
				eq(files.bucketId, bucket.id),
				eq(files.isClosed, true),
				likePrefix(files.path, prefix),
			];
			const dirConditions: (SQL | undefined)[] = [
				eq(directories.bucketId, bucket.id),
				likePrefix(directories.path, prefix),
			];
			for (const excludedPath of excludePaths) {
				const normalizedExcludedPath = excludedPath.endsWith('/') ? excludedPath : `${excludedPath}/`;
				if (normalizedExcludedPath === prefix) {
					dirConditions.push(ne(directories.path, normalizedExcludedPath));
					continue;
				}
				dirConditions.push(ne(directories.path, normalizedExcludedPath));
				dirConditions.push(notLikePrefix(directories.path, normalizedExcludedPath));
				fileConditions.push(ne(files.path, excludedPath));
				fileConditions.push(notLikePrefix(files.path, normalizedExcludedPath));
			}

			const childFiles = await db.select().from(files).where(and(...fileConditions));
			const directoryCountForTarget = (await db
				.select({ count: count() })
				.from(directories)
				.where(and(...dirConditions))
				.get())?.count ?? 0;
			const fileCountForTarget = childFiles.length;
			const countForTarget = directoryCountForTarget + fileCountForTarget;

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
			matchedCount += 1;
			for (const file of childFiles) filesToPurge.set(file.id, file);
			await db.update(files)
				.set({ isListed: body.isListed })
				.where(and(...fileConditions));
			await db.update(directories)
				.set({ isListed: body.isListed })
				.where(and(...dirConditions));
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
		const { limit, cursor } = pageParams(c.req.valid('json'));

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
			.where(cursor ? and(eq(files.userId, user.id), lt(files.id, cursor)) : eq(files.userId, user.id))
			.orderBy(desc(files.id))
			.limit(limit + 1);

		const items = userFiles.slice(0, limit);
		return c.json({
			items,
			nextCursor: userFiles.length > limit ? items.at(-1)?.id ?? null : null,
			hasMore: userFiles.length > limit,
		}, 200);
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
				.where(and(eq(files.bucketId, bucket.id), likePrefix(files.path, prefix)));

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
				.where(and(eq(directories.bucketId, bucket.id), likePrefix(directories.path, prefix)));
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
			await db.delete(directories).where(and(eq(directories.bucketId, bucket.id), likePrefix(directories.path, prefix)));
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
		if (user.isAdmin && bucket.userId !== user.id) {
			const fileIds = Array.from(filesToDelete.keys());
			await recordModerationAuditLog(c, 'admin_file_deleted', {
				targetFileId: fileIds.length === 1 ? fileIds[0] : null,
				targetUserId: bucket.userId,
				data: {
					bucketId: bucket.id,
					bucketName: bucket.name,
					targets,
					fileIds,
				},
			});
		}

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
				.where(and(eq(files.bucketId, targetBucket.id), likePrefix(files.path, normalizedTargetPath)))
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
			if (hasSuspiciousFileType(normalizedTargetPath, file.mimeType ?? undefined) && await shouldRejectMismatchedFileType(c.env)) {
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
			await ensureAncestorDirectories(db, targetBucket.id, normalizedTargetPath);

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
			.where(and(eq(files.bucketId, sourceBucket.id), likePrefix(files.path, normalizedSourcePath)));
		const childDirectories = await db
			.select()
			.from(directories)
			.where(and(eq(directories.bucketId, sourceBucket.id), likePrefix(directories.path, normalizedSourcePath)));
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
