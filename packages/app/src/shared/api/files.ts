import * as v from 'valibot';
import { errorResponse, IdString, PageRequestFields, pagedResponse } from '../api.schemas.js';
import { fileVisibilitySchema } from '../file-visibility.js';
import { filePathValidation } from '../name-validation.js';
import {
	MAX_ARCHIVE_INDEX_ENTRIES,
	MAX_BUCKET_NAME_LENGTH,
	MAX_DELETE_TARGETS,
	MAX_FILE_PATH_LENGTH,
	MAX_MIME_TYPE_LENGTH,
	MAX_PASSPHRASE_LENGTH,
} from '../const.js';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';

const BucketNameString = v.pipe(v.string(), v.maxLength(MAX_BUCKET_NAME_LENGTH));
const FilePathString = v.pipe(v.string(), v.maxLength(MAX_FILE_PATH_LENGTH));
const FileCreatePathString = v.pipe(v.string(), v.maxLength(MAX_FILE_PATH_LENGTH), filePathValidation);
const MimeTypeString = v.pipe(v.string(), v.maxLength(MAX_MIME_TYPE_LENGTH));
const NonNegativeSafeInteger = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));

const UploadingFileResponse = v.pipe(
	v.object({
		id: IdString,
		bucketId: IdString,
		bucketName: BucketNameString,
		path: FilePathString,
		size: v.nullable(v.number()),
		isClosed: v.boolean(),
		visibility: fileVisibilitySchema,
		isListed: v.boolean(),
		uploadExpiresAt: v.number(),
		isTargz: v.boolean(),
		isTar: v.boolean(),
	}),
	v.metadata({ ref: 'UploadingFile' }),
);

const FileListEntry = v.pipe(
	v.object({
		type: v.union([v.literal('dir'), v.literal('file')]),
		name: FilePathString,
		path: v.optional(FilePathString),
		fileId: v.optional(IdString),
		size: v.optional(v.number()),
		mimeType: v.optional(MimeTypeString),
		isTargz: v.optional(v.boolean()),
		isTar: v.optional(v.boolean()),
		isEncrypted: v.optional(v.boolean()),
		visibility: v.optional(fileVisibilitySchema),
		isListed: v.optional(v.boolean()),
		isModerationForcedPrivate: v.optional(v.boolean()),
		downloadCount: v.optional(v.number()),
		isDownloadCountEnabled: v.optional(v.boolean()),
		isDownloadCountVisible: v.optional(v.boolean()),
	}),
	v.metadata({ ref: 'FileListEntry' }),
);

export const filesApiDef = {
	'/api/files/create/open': {
		summary: 'Open a new file upload',
		tags: ['files'],
		req: v.object({
			bucketId: IdString,
			path: FileCreatePathString,
			partSize: v.optional(v.number()),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ fileId: v.string(), uploadExpiry: v.number(), partSize: v.number() }) } } },
			400: errorResponse('Bad request (missing fields or invalid partSize)', ['INVALID_FILE_PATH']),
			404: errorResponse('Bucket not found', ['BUCKET_NOT_FOUND']),
			409: errorResponse('File already exists', ['FILE_ALREADY_EXISTS']),
			429: errorResponse('File or upload limit exceeded', ['FILE_LIMIT_EXCEEDED', 'DAILY_UPLOAD_LIMIT_EXCEEDED']),
		},
	},
	'/api/files/create/targz-index': {
		summary: 'Register tar.gz index for a file',
		tags: ['files'],
		req: v.object({
			fileId: IdString,
			files: v.pipe(v.array(v.object({
				path: FileCreatePathString,
				mimeType: MimeTypeString,
				aStart: NonNegativeSafeInteger,
				aFirstEnd: NonNegativeSafeInteger,
				aFinalStart: NonNegativeSafeInteger,
				aEnd: NonNegativeSafeInteger,
				rStartOffset: NonNegativeSafeInteger,
				rEndOffset: NonNegativeSafeInteger,
			})), v.maxLength(MAX_ARCHIVE_INDEX_ENTRIES)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: errorResponse('Bad request (missing fields)', ['INVALID_FILE_PATH']),
			404: errorResponse('File not found', ['FILE_NOT_FOUND', 'BUCKET_NOT_FOUND']),
			410: errorResponse('Upload expired', ['UPLOAD_EXPIRED']),
		},
	},
	'/api/files/create/tar-index': {
		summary: 'Register tar index for a file',
		tags: ['files'],
		req: v.object({
			fileId: IdString,
			files: v.pipe(v.array(v.object({
				path: FileCreatePathString,
				mimeType: MimeTypeString,
				offset: NonNegativeSafeInteger,
				size: NonNegativeSafeInteger,
			})), v.maxLength(MAX_ARCHIVE_INDEX_ENTRIES)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: errorResponse('Bad request (missing fields)', ['INVALID_FILE_PATH']),
			404: errorResponse('File not found', ['FILE_NOT_FOUND', 'BUCKET_NOT_FOUND']),
			410: errorResponse('Upload expired', ['UPLOAD_EXPIRED']),
		},
	},
	'/api/files/create/close': {
		summary: 'Close (finalize) a file upload',
		tags: ['files'],
		req: v.object({
			fileId: IdString,
			visibility: fileVisibilitySchema,
			isListed: v.optional(v.boolean()),
			passphrase: v.optional(v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH))),
			isDownloadCountEnabled: v.optional(v.boolean()),
			isDownloadCountVisible: v.optional(v.boolean()),
			mimeType: v.optional(MimeTypeString),
			/** クライアントサイドE2E暗号化が適用されているか */
			isEncrypted: v.optional(v.boolean()),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: errorResponse('Bad request (missing fileId, upload incomplete, or finalization failure)', ['FILE_ID_IS_REQUIRED', 'UPLOAD_HAS_NOT_BEEN_COMPLETED', 'FAILED_TO_FINALIZE_UPLOAD', 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION']),
			404: errorResponse('File not found', ['FILE_NOT_FOUND', 'BUCKET_NOT_FOUND']),
			410: errorResponse('Upload expired', ['UPLOAD_EXPIRED']),
			429: errorResponse('Bucket size limit exceeded', ['BUCKET_LIMIT_EXCEEDED']),
		},
	},
	'/api/files/create/status': {
		summary: 'Get upload status',
		tags: ['files'],
		req: v.object({
			fileId: IdString,
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ partCount: v.number(), offset: v.number(), partSize: v.number() }) } } },
			400: errorResponse('Bad request (missing fileId)', ['FILE_ID_IS_REQUIRED']),
			404: errorResponse('File not found', ['FILE_NOT_FOUND']),
		},
	},
	'/api/files/ls': {
		summary: 'List files in a bucket path',
		tags: ['files'],
		req: v.object({
			bucketName: BucketNameString,
			path: v.optional(FilePathString),
			...PageRequestFields,
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({
				type: v.literal('directory'),
				items: v.array(FileListEntry),
				nextCursor: v.nullable(v.string()),
				hasMore: v.boolean(),
				ownerCanDisableFileAds: v.boolean(),
			}) } } },
			404: errorResponse('Bucket or directory not found', ['BUCKET_NOT_FOUND', 'DIRECTORY_NOT_FOUND']),
		},
	},
	'/api/files/update': {
		summary: 'Update file visibility',
		tags: ['files'],
		req: v.object({
			bucketName: BucketNameString,
			filePath: FilePathString,
			visibility: fileVisibilitySchema,
			isListed: v.optional(v.boolean()),
			passphrase: v.optional(v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH))),
			isDownloadCountEnabled: v.optional(v.boolean()),
			isDownloadCountVisible: v.optional(v.boolean()),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: errorResponse('Bad request (missing fields, file not closed, or public file cannot be made private)', ['BUCKET_NAME_IS_REQUIRED', 'FILE_IS_NOT_CLOSED', 'PUBLIC_FILES_CANNOT_CHANGE_VISIBILITY']),
			404: errorResponse('Bucket or file not found', ['BUCKET_NOT_FOUND', 'FILE_NOT_FOUND']),
		},
	},
	'/api/files/update-listing': {
		summary: 'Update file listing visibility',
		tags: ['files'],
		req: v.object({
			bucketId: IdString,
			isListed: v.boolean(),
			targets: v.pipe(v.array(v.object({
				type: v.union([v.literal('file'), v.literal('directory')]),
				path: FilePathString,
				excludePaths: v.optional(v.pipe(v.array(FilePathString), v.maxLength(MAX_DELETE_TARGETS))),
			})), v.maxLength(MAX_DELETE_TARGETS)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true), updatedCount: v.number() }) } } },
			400: errorResponse('Bad request (missing fields)', ['BUCKET_NOT_FOUND']),
			404: errorResponse('Bucket not found', ['BUCKET_NOT_FOUND', 'FILE_NOT_FOUND']),
		},
	},
	'/api/files/uploadings': {
		summary: 'List in-progress uploads',
		tags: ['files'],
		req: v.object(PageRequestFields),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(UploadingFileResponse) } } },
		},
	},
	'/api/files/delete': {
		summary: 'Delete files and directories',
		tags: ['files'],
		req: v.object({
			bucketId: IdString,
			path: v.optional(FilePathString),
			targets: v.optional(v.pipe(v.array(v.object({
				type: v.union([v.literal('file'), v.literal('directory')]),
				path: FilePathString,
				excludePaths: v.optional(v.pipe(v.array(FilePathString), v.maxLength(MAX_DELETE_TARGETS))),
			})), v.maxLength(MAX_DELETE_TARGETS))),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: errorResponse('Bad request (missing fields)', ['BUCKET_NOT_FOUND', 'PATH_OR_TARGETS_ARE_REQUIRED']),
			404: errorResponse('File or bucket not found', ['FILE_NOT_FOUND', 'BUCKET_NOT_FOUND']),
		},
	},
	'/api/files/move': {
		summary: 'Move or rename a file or directory',
		tags: ['files'],
		req: v.object({
			type: v.union([v.literal('file'), v.literal('directory')]),
			sourceBucketId: IdString,
			sourcePath: FilePathString,
			targetBucketId: IdString,
			targetPath: FilePathString,
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: errorResponse('Bad request (missing fields or invalid path)', ['SOURCE_AND_TARGET_PATHS_ARE_REQUIRED', 'INVALID_FILE_PATH', 'INVALID_DIRECTORY_PATH', 'DIRECTORY_CANNOT_BE_MOVED_INTO_ITSELF', 'FILE_IS_NOT_CLOSED', 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION']),
			404: errorResponse('Bucket, file, or directory not found', ['BUCKET_NOT_FOUND', 'FILE_NOT_FOUND', 'DIRECTORY_NOT_FOUND']),
			409: errorResponse('Target already exists', ['TARGET_ALREADY_EXISTS']),
			429: errorResponse('Target bucket size limit exceeded', ['TARGET_BUCKET_SIZE_LIMIT_EXCEEDED']),
		},
	},
	'/api/files/meta': {
		summary: 'Get file metadata by bucket name and path',
		tags: ['files'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({
				visibility: fileVisibilitySchema,
				isModerationForcedPrivate: v.boolean(),
				isTargz: v.boolean(),
				isTar: v.boolean(),
				isEncrypted: v.boolean(),
				size: v.nullable(v.number()),
				mimeType: v.nullable(MimeTypeString),
				extensionMimeType: v.optional(MimeTypeString),
				hasMimeTypeMismatch: v.boolean(),
				hasExecutableContent: v.boolean(),
				isListed: v.optional(v.boolean()),
				downloadCount: v.optional(v.number()),
				isDownloadCountEnabled: v.optional(v.boolean()),
				isDownloadCountVisible: v.optional(v.boolean()),
				canUseDownloadCount: v.optional(v.boolean()),
				ownerCanDisableFileAds: v.boolean(),
				fileId: v.optional(v.string()),
				bucketId: v.optional(v.string()),
			}) } } },
			404: errorResponse('Bucket or file not found', ['BUCKET_NOT_FOUND', 'FILE_NOT_FOUND']),
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
