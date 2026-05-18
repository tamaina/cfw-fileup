/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const CreateBucketBody = v.object({
	bucketName: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});
export type CreateBucketBody = v.InferOutput<typeof CreateBucketBody>;

export const DeleteBucketBody = v.object({
	bucketId: v.string(),
});
export type DeleteBucketBody = v.InferOutput<typeof DeleteBucketBody>;
