/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const fileTokensApiDef = {
	'/api/file-tokens/create': {
		req: v.object({
			bucketName: v.string(),
			filePath: v.string(),
			expiresIn: v.nullable(v.number()),
		}),
		res: v.object({
			id: v.string(),
			token: v.string(),
			expiresAt: v.nullable(v.number()),
		}),
	},
	'/api/file-tokens/list': {
		req: v.object({
			bucketName: v.string(),
			filePath: v.string(),
		}),
		res: v.object({
			tokens: v.array(v.object({
				id: v.string(),
				expiresAt: v.nullable(v.number()),
				createdAt: v.number(),
			})),
		}),
	},
	'/api/file-tokens/delete': {
		req: v.object({
			tokenId: v.string(),
		}),
		res: v.object({ ok: v.literal(true) }),
	},
};
