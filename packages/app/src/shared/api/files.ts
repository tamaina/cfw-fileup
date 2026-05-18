import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';

const UploadingFileResponse = v.pipe(
	v.object({
		id: v.string(),
		bucketId: v.string(),
		bucketName: v.string(),
		path: v.string(),
		size: v.nullable(v.number()),
		isClosed: v.boolean(),
		isPublic: v.boolean(),
		uploadExpiresAt: v.number(),
		isTargz: v.boolean(),
		isTar: v.boolean(),
	}),
	v.metadata({ ref: 'UploadingFile' }),
);

export const filesApiDef = {
	'/api/files/create/open': {
		summary: 'Open a new file upload',
		tags: ['files'],
		req: v.object({
			bucketId: v.string(),
			path: v.string(),
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
			fileId: v.string(),
			files: v.array(v.object({
				path: v.string(),
				mimeType: v.string(),
				aStart: v.number(),
				aFirstEnd: v.number(),
				aFinalStart: v.number(),
				aEnd: v.number(),
				rStartOffset: v.number(),
				rEndOffset: v.number(),
			})),
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
			fileId: v.string(),
			files: v.array(v.object({
				path: v.string(),
				mimeType: v.string(),
				offset: v.number(),
				size: v.number(),
			})),
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
			fileId: v.string(),
			isPublic: v.boolean(),
			passphrase: v.optional(v.string()),
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
			fileId: v.string(),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ partCount: v.number(), offset: v.number(), partSize: v.number() }) } } },
			400: { description: 'Bad request (missing fileId)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'File not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/files/update': {
		summary: 'Update file visibility',
		tags: ['files'],
		req: v.object({
			bucketName: v.string(),
			filePath: v.string(),
			isPublic: v.boolean(),
			passphrase: v.optional(v.string()),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields or file not closed)', content: { 'application/json': { vSchema: ErrorResponse } } },
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
		summary: 'Delete a file',
		tags: ['files'],
		req: v.object({
			bucketId: v.string(),
			path: v.string(),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'File or bucket not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
