import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';

export const fileTokensApiDef = {
	'/api/file-tokens/create': {
		summary: 'Create a file access token',
		tags: ['file-tokens'],
		req: v.object({
			bucketName: v.string(),
			filePath: v.string(),
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
			bucketName: v.string(),
			filePath: v.string(),
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
			tokenId: v.string(),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing tokenId)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Token not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
