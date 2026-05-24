import * as v from 'valibot';
import { errorResponse, IdString } from '../api.schemas.js';
import { MAX_TURNSTILE_TOKEN_LENGTH } from '../const.js';
import { fileReportReasonSchema, fileReportRelationshipSchema } from '../file-reports.js';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';

const ReportText = (maxLength: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maxLength));

const OkResponse = { 200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true), id: IdString }) } } } };

export const fileReportsApiDef = {
	'/api/file-reports/create': {
		summary: 'Report a file',
		tags: ['file-reports'],
		req: v.object({
			fileId: IdString,
			reporterName: ReportText(100),
			reporterEmail: v.optional(v.nullable(ReportText(320))),
			reasonId: fileReportReasonSchema,
			relationshipId: fileReportRelationshipSchema,
			contact: v.optional(v.nullable(ReportText(500))),
			summary: ReportText(200),
			detail: ReportText(4000),
			turnstileToken: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURNSTILE_TOKEN_LENGTH))),
		}),
		res: {
			...OkResponse,
			400: errorResponse('Bad request (missing required fields or Turnstile failure)', ['TURNSTILE_TOKEN_IS_REQUIRED', 'TURNSTILE_VERIFICATION_FAILED']),
			404: errorResponse('File not found', ['FILE_NOT_FOUND']),
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
