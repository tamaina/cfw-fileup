import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';

export const bucketsApiDef = {
	'/api/buckets/create': {
		summary: 'Create a bucket',
		tags: ['buckets'],
		req: v.object({
			bucketName: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ bucketId: v.string() }) } } },
			400: { description: 'Bad request (invalid bucket name)', content: { 'application/json': { vSchema: ErrorResponse } } },
			409: { description: 'Bucket name already exists', content: { 'application/json': { vSchema: ErrorResponse } } },
			429: { description: 'Bucket limit exceeded', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/buckets/delete': {
		summary: 'Delete a bucket',
		tags: ['buckets'],
		req: v.object({
			bucketId: v.string(),
		}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing bucketId)', content: { 'application/json': { vSchema: ErrorResponse } } },
			404: { description: 'Bucket not found', content: { 'application/json': { vSchema: ErrorResponse } } },
		},
	},
	'/api/buckets/list': {
		summary: 'List buckets',
		tags: ['buckets'],
		req: v.object({}),
		res: {
			200: { description: 'Success', content: { 'application/json': { vSchema: v.object({
				buckets: v.array(v.object({ id: v.string(), name: v.string(), usedBytes: v.number() })),
				maxBucketSizeBytes: v.nullable(v.number()),
			}) } } },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
