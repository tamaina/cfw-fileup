/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
		res: v.object({
			fileId: v.string(),
			uploadExpiry: v.number(),
			partSize: v.number(),
		}),
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
		res: v.object({ ok: v.literal(true) }),
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
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/files/create/close': {
		req: v.object({
			fileId: v.string(),
			isPublic: v.boolean(),
			passphrase: v.optional(v.string()),
		}),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/files/create/status': {
		req: v.object({
			fileId: v.string(),
		}),
		res: v.object({
			partCount: v.number(),
			offset: v.number(),
			partSize: v.number(),
		}),
	},
	'/api/files/update': {
		req: v.object({
			bucketName: v.string(),
			filePath: v.string(),
			isPublic: v.boolean(),
			passphrase: v.optional(v.string()),
		}),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/files/uploadings': {
		req: v.object({}),
		res: v.object({
			files: v.array(UploadingFileResponse),
		}),
	},
	'/api/files/delete': {
		req: v.object({
			bucketId: v.string(),
			path: v.string(),
		}),
		res: v.object({ ok: v.literal(true) }),
	},
};
