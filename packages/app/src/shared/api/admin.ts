/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const QuotaBody = v.object({
	maxBuckets: v.optional(v.nullable(v.number())),
	maxBucketSizeBytes: v.optional(v.nullable(v.number())),
	maxFilesPerBucket: v.optional(v.nullable(v.number())),
	maxDailyUploads: v.optional(v.nullable(v.number())),
});
export type QuotaBody = v.InferOutput<typeof QuotaBody>;

export const SuspendUserBody = v.object({
	userId: v.string(),
});
export type SuspendUserBody = v.InferOutput<typeof SuspendUserBody>;

export const DeleteFileAdminBody = v.object({
	fileId: v.string(),
});
export type DeleteFileAdminBody = v.InferOutput<typeof DeleteFileAdminBody>;

export const DeleteBucketAdminBody = v.object({
	bucketId: v.string(),
});
export type DeleteBucketAdminBody = v.InferOutput<typeof DeleteBucketAdminBody>;

export const UpdateSettingBody = v.object({
	key: v.string(),
	value: v.string(),
});
export type UpdateSettingBody = v.InferOutput<typeof UpdateSettingBody>;

export const ToggleRegistrationBody = v.object({
	enabled: v.boolean(),
});
export type ToggleRegistrationBody = v.InferOutput<typeof ToggleRegistrationBody>;
