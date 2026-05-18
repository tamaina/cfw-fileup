/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

const QuotaResponse = v.pipe(
	v.object({
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
	}),
	v.metadata({ ref: 'Quota' }),
);

export const adminApiDef = {
	'/api/admin/suspend-user': {
		req: v.object({ userId: v.string() }),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/admin/delete-file': {
		req: v.object({ fileId: v.string() }),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/admin/delete-bucket': {
		req: v.object({ bucketId: v.string() }),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/admin/set-user-quota/:userId': {
		req: v.object({
			maxBuckets: v.optional(v.nullable(v.number())),
			maxBucketSizeBytes: v.optional(v.nullable(v.number())),
			maxFilesPerBucket: v.optional(v.nullable(v.number())),
			maxDailyUploads: v.optional(v.nullable(v.number())),
		}),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/admin/set-global-quota': {
		req: v.object({
			maxBuckets: v.optional(v.nullable(v.number())),
			maxBucketSizeBytes: v.optional(v.nullable(v.number())),
			maxFilesPerBucket: v.optional(v.nullable(v.number())),
			maxDailyUploads: v.optional(v.nullable(v.number())),
		}),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/admin/get-user-quota/:userId': {
		req: v.object({}),
		res: QuotaResponse,
	},
	'/api/admin/get-global-quota': {
		req: v.object({}),
		res: QuotaResponse,
	},
	'/api/admin/delete-user-quota/:userId': {
		req: v.object({}),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/admin/list-users': {
		req: v.object({}),
		res: v.array(v.object({
			id: v.string(),
			username: v.string(),
			isAdmin: v.boolean(),
			isSuspended: v.boolean(),
		})),
	},
	'/api/admin/toggle-registration': {
		req: v.object({ enabled: v.boolean() }),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/admin/update-setting': {
		req: v.object({ key: v.string(), value: v.string() }),
		res: v.object({ ok: v.literal(true) }),
	},
	'/api/admin/get-settings': {
		req: v.object({}),
		res: v.array(v.object({ key: v.string(), value: v.string() })),
	},
};
