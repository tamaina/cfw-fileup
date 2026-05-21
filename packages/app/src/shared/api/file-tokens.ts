import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse, IdString } from '../api.schemas.js';
import { MAX_BUCKET_NAME_LENGTH, MAX_FILE_PATH_LENGTH, MAX_PASSPHRASE_LENGTH, MAX_TURNSTILE_TOKEN_LENGTH } from '../const.js';

const BucketNameString = v.pipe(v.string(), v.maxLength(MAX_BUCKET_NAME_LENGTH));
const FilePathString = v.pipe(v.string(), v.maxLength(MAX_FILE_PATH_LENGTH));

export const fileTokensApiDef = {
	'/api/file-tokens/create': {
		summary: 'Create a file access token',
		tags: ['file-tokens'],
		req: v.object({
			bucketName: BucketNameString,
			filePath: FilePathString,
			expiresIn: v.nullable(v.number()),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ id: v.string(), token: v.string(), expiresAt: v.nullable(v.number()) }) } } },
			400: { description: 'Bad request (invalid expiresIn, file not closed, or file is public)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Bucket or file not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/file-tokens/list': {
		summary: 'List file access tokens',
		tags: ['file-tokens'],
		req: v.object({
			bucketName: BucketNameString,
			filePath: FilePathString,
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({
				tokens: v.array(v.object({ id: v.string(), expiresAt: v.nullable(v.number()), createdAt: v.number() })),
			}) } } },
			400: { description: 'Bad request (missing fields)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Bucket or file not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/file-tokens/delete': {
		summary: 'Delete a file access token',
		tags: ['file-tokens'],
		req: v.object({
			tokenId: IdString,
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing tokenId)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Token not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/file-tokens/create-by-passphrase': {
		summary: 'Create a file access token by passphrase',
		tags: ['file-tokens'],
		req: v.object({
			bucketName: BucketNameString,
			filePath: FilePathString,
			passphrase: v.pipe(v.string(), v.maxLength(MAX_PASSPHRASE_LENGTH)),
			turnstileToken: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURNSTILE_TOKEN_LENGTH))),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ id: v.string(), token: v.string(), expiresAt: v.number(), fileId: v.string() }) } } },
			400: { description: 'Bad request (missing fields, Turnstile verification failed, file not closed, or file is public)', content: { 'application/json': { vSchema: ErrorResponse } } },
			403: { description: 'Forbidden (no passphrase set or invalid passphrase)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Bucket or file not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
