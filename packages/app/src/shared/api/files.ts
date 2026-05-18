import * as v from 'valibot';

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
		req: v.object({
			bucketId: v.string(),
			path: v.string(),
			partSize: v.optional(v.number()),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ fileId: v.string(), uploadExpiry: v.number(), partSize: v.number() }) } } },
			400: { description: 'Bad request (missing fields or invalid partSize)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'Bucket not found' },
			409: { description: 'File already exists' },
			429: { description: 'File or upload limit exceeded' },
		},
	},
	'/api/files/create/targz-index': {
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
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'File not found' },
			410: { description: 'Upload expired' },
		},
	},
	'/api/files/create/tar-index': {
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
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'File not found' },
			410: { description: 'Upload expired' },
		},
	},
	'/api/files/create/close': {
		req: v.object({
			fileId: v.string(),
			isPublic: v.boolean(),
			passphrase: v.optional(v.string()),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fileId, upload incomplete, or finalization failure)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'File not found' },
			410: { description: 'Upload expired' },
			429: { description: 'Bucket size limit exceeded' },
		},
	},
	'/api/files/create/status': {
		req: v.object({
			fileId: v.string(),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ partCount: v.number(), offset: v.number(), partSize: v.number() }) } } },
			400: { description: 'Bad request (missing fileId)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'File not found' },
		},
	},
	'/api/files/update': {
		req: v.object({
			bucketName: v.string(),
			filePath: v.string(),
			isPublic: v.boolean(),
			passphrase: v.optional(v.string()),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields or file not closed)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'Bucket or file not found' },
		},
	},
	'/api/files/uploadings': {
		req: v.object({}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ files: v.array(UploadingFileResponse) }) } } },
			401: { description: 'Unauthorized' },
		},
	},
	'/api/files/delete': {
		req: v.object({
			bucketId: v.string(),
			path: v.string(),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing fields)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'File or bucket not found' },
		},
	},
};
