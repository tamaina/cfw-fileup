import * as v from 'valibot';

export const directoriesApiDef = {
	'/api/directories/create': {
		req: v.object({
			bucketId: v.string(),
			path: v.string(),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing bucketId or path)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'Bucket not found' },
		},
	},
	'/api/directories/delete': {
		req: v.object({
			bucketId: v.string(),
			path: v.string(),
		}),
		res: {
			200: { content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
			400: { description: 'Bad request (missing bucketId or path)' },
			401: { description: 'Unauthorized' },
			403: { description: 'Forbidden' },
			404: { description: 'Bucket not found' },
		},
	},
};
