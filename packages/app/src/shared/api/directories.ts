import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse, IdString } from '../api.schemas.js';
import { MAX_FILE_PATH_LENGTH } from '../const.js';

export const directoriesApiDef = {
	'/api/directories/create': {
		summary: 'Create a directory',
		tags: ['directories'],
		req: v.object({
			bucketId: IdString,
			path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_FILE_PATH_LENGTH)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing bucketId or path)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Bucket not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/directories/delete': {
		summary: 'Delete a directory',
		tags: ['directories'],
		req: v.object({
			bucketId: IdString,
			path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_FILE_PATH_LENGTH)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing bucketId or path)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Bucket not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
