/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const bucketsApiDef = {
	'/api/buckets/create': {
		req: v.object({
			bucketName: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
		}),
		res: v.object({
			bucketId: v.string(),
		}),
	},
	'/api/buckets/delete': {
		req: v.object({
			bucketId: v.string(),
		}),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/buckets/list': {
		req: v.object({}),
		res: v.object({
			buckets: v.array(v.object({
				id: v.string(),
				name: v.string(),
				usedBytes: v.number(),
			})),
			maxBucketSizeBytes: v.nullable(v.number()),
		}),
	},
};
