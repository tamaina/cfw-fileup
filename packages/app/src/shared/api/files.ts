/*
 * SPDX-FileCopyrightText: tamaina and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as v from 'valibot';

export const CreateOpenBody = v.object({
	bucketId: v.string(),
	path: v.string(),
	partSize: v.optional(v.number()),
});
export type CreateOpenBody = v.InferOutput<typeof CreateOpenBody>;

const TarEntry = v.object({
	path: v.string(),
	mimeType: v.string(),
	offset: v.number(),
	size: v.number(),
});

const TargzEntry = v.object({
	path: v.string(),
	mimeType: v.string(),
	aStart: v.number(),
	aFirstEnd: v.number(),
	aFinalStart: v.number(),
	aEnd: v.number(),
	rStartOffset: v.number(),
	rEndOffset: v.number(),
});

export const TargzIndexBody = v.object({
	fileId: v.string(),
	files: v.array(TargzEntry),
});
export type TargzIndexBody = v.InferOutput<typeof TargzIndexBody>;

export const TarIndexBody = v.object({
	fileId: v.string(),
	files: v.array(TarEntry),
});
export type TarIndexBody = v.InferOutput<typeof TarIndexBody>;

export const CreateCloseBody = v.object({
	fileId: v.string(),
	isPublic: v.boolean(),
	passphrase: v.optional(v.string()),
});
export type CreateCloseBody = v.InferOutput<typeof CreateCloseBody>;

export const CreateStatusBody = v.object({
	fileId: v.string(),
});
export type CreateStatusBody = v.InferOutput<typeof CreateStatusBody>;

export const DeleteFileBody = v.object({
	bucketId: v.string(),
	path: v.string(),
});
export type DeleteFileBody = v.InferOutput<typeof DeleteFileBody>;

export const UpdateFileBody = v.object({
	bucketName: v.string(),
	filePath: v.string(),
	isPublic: v.boolean(),
	passphrase: v.optional(v.string()),
});
export type UpdateFileBody = v.InferOutput<typeof UpdateFileBody>;
