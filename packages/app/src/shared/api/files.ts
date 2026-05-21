import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse, IdString } from '../api.schemas.js';
import { fileVisibilitySchema } from '../file-visibility.js';
import {
	MAX_ARCHIVE_INDEX_ENTRIES,
	MAX_BUCKET_NAME_LENGTH,
	MAX_DELETE_TARGETS,
	MAX_FILE_PATH_LENGTH,
	MAX_MIME_TYPE_LENGTH,
	MAX_PASSPHRASE_LENGTH,
} from '../const.js';

const BucketNameString = v.pipe(v.string(), v.maxLength(MAX_BUCKET_NAME_LENGTH));
const FilePathString = v.pipe(v.string(), v.maxLength(MAX_FILE_PATH_LENGTH));
const MimeTypeString = v.pipe(v.string(), v.maxLength(MAX_MIME_TYPE_LENGTH));

const UploadingFileResponse = v.pipe(
	v.object({
		id: IdString,
		bucketId: IdString,
		bucketName: BucketNameString,
		path: FilePathString,
		size: v.nullable(v.number()),
		isClosed: v.boolean(),
		visibility: fileVisibilitySchema,
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
		visibility: v.optional(fileVisibilitySchema),
	}),
	v.metadata({ ref: 'FileListEntry' }),
);

export const filesApiDef = {
	'/api/files/create/open': {
		summary: 'Open a new file upload',
		tags: ['files'],
		req: v.object({
			bucketId: IdString,
			path: FilePathString,
			partSize: v.optional(v.number()),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ fileId: v.string(), uploadExpiry: v.number(), partSize: v.number() }) } } },
			400: { description: 'Bad request (missing fields or invalid partSize)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Bucket not found', content: { 'application/json': { vSchema: ErrorResponse } } },
			409: { description: 'File already exists', content: { 'application/json': { vSchema: ErrorResponse } } },
			429: { description: 'File or upload limit exceeded', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/files/create/targz-index': {
		summary: 'Register tar.gz index for a file',
		tags: ['files'],
		req: v.object({
			fileId: IdString,
			files: v.pipe(v.array(v.object({
				path: FilePathString,
				mimeType: MimeTypeString,
				aStart: v.number(),
				aFirstEnd: v.number(),
				aFinalStart: v.number(),
				aEnd: v.number(),
				rStartOffset: v.number(),
				rEndOffset: v.number(),
			})), v.maxLength(MAX_ARCHIVE_INDEX_ENTRIES)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'File not found', content: { 'application/json': { vSchema: ErrorResponse } } },
			410: { description: 'Upload expired', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/files/create/tar-index': {
		summary: 'Register tar index for a file',
		tags: ['files'],
		req: v.object({
			fileId: IdString,
			files: v.pipe(v.array(v.object({
				path: FilePathString,
				mimeType: MimeTypeString,
				offset: v.number(),
				size: v.number(),
			})), v.maxLength(MAX_ARCHIVE_INDEX_ENTRIES)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'File not found', content: { 'application/json': { vSchema: ErrorResponse } } },
			410: { description: 'Upload expired', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/files/create/close': {
		summary: 'Close (finalize) a file upload',
		tags: ['files'],
		req: v.object({
			fileId: IdString,
			visibility: fileVisibilitySchema,
			passphrase: v.optional(v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH))),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fileId, upload incomplete, or finalization failure)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'File not found', content: { 'application/json': { vSchema: ErrorResponse } } },
			410: { description: 'Upload expired', content: { 'application/json': { vSchema: ErrorResponse } } },
			429: { description: 'Bucket size limit exceeded', content: { 'application/json': { vSchema: ErrorResponse } } },
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
			400: { description: 'Bad request (missing fileId)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'File not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/files/ls': {
		summary: 'List files in a bucket path',
		tags: ['files'],
		req: v.object({
			bucketName: BucketNameString,
			path: v.optional(FilePathString),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({
				type: v.literal('directory'),
				entries: v.array(FileListEntry),
			}) } } },
			404: { description: 'Bucket or directory not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/files/update': {
		summary: 'Update file visibility',
		tags: ['files'],
		req: v.object({
			bucketName: BucketNameString,
			filePath: FilePathString,
			visibility: fileVisibilitySchema,
			passphrase: v.optional(v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH))),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields, file not closed, or public file cannot be made private)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Bucket or file not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/files/uploadings': {
		summary: 'List in-progress uploads',
		tags: ['files'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ files: v.array(UploadingFileResponse) }) } } },
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
			400: { description: 'Bad request (missing fields)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'File or bucket not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/files/meta': {
		summary: 'Get file metadata by bucket name and path',
		tags: ['files'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({
				visibility: fileVisibilitySchema,
				isTargz: v.boolean(),
				isTar: v.boolean(),
				size: v.nullable(v.number()),
				fileId: v.optional(v.string()),
				bucketId: v.optional(v.string()),
			}) } } },
			404: { description: 'Bucket or file not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
