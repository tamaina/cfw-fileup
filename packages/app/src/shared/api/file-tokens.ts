/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const CreateFileTokenBody = v.object({
	bucketName: v.string(),
	filePath: v.string(),
	expiresIn: v.nullable(v.number()),
});
export type CreateFileTokenBody = v.InferOutput<typeof CreateFileTokenBody>;

export const ListFileTokensBody = v.object({
	bucketName: v.string(),
	filePath: v.string(),
});
export type ListFileTokensBody = v.InferOutput<typeof ListFileTokensBody>;

export const DeleteFileTokenBody = v.object({
	tokenId: v.string(),
});
export type DeleteFileTokenBody = v.InferOutput<typeof DeleteFileTokenBody>;
