import * as v from 'valibot';

export const fileTokensApiDef = {
	'/api/file-tokens/create': {
		req: v.object({
			bucketName: v.string(),
			filePath: v.string(),
			expiresIn: v.nullable(v.number()),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ id: v.string(), token: v.string(), expiresAt: v.nullable(v.number()) }) } } },
			400: { description: 'Bad request (invalid expiresIn, file not closed, or file is public)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden (not owner or admin)' },
			404: { description: 'Bucket or file not found' },
		},
	},
	'/api/file-tokens/list': {
		req: v.object({
			bucketName: v.string(),
			filePath: v.string(),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({
				tokens: v.array(v.object({ id: v.string(), expiresAt: v.nullable(v.number()), createdAt: v.number() })),
			}) } } },
			400: { description: 'Bad request (missing fields)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden (not owner or admin)' },
			404: { description: 'Bucket or file not found' },
		},
	},
	'/api/file-tokens/delete': {
		req: v.object({
			tokenId: v.string(),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing tokenId)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden (not owner or admin)' },
			404: { description: 'Token not found' },
		},
	},
};
