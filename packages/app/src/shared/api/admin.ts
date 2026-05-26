import * as v from 'valibot';
import { errorResponse, IdString, PageRequestFields, pagedResponse } from '../api.schemas.js';
import { KnownSettingListSchema, KnownSettingRecordSchema } from '../app-settings.js';
import { fileReportReasonSchema, fileReportRelationshipSchema, fileReportStatusSchema } from '../file-reports.js';
import { fileVisibilitySchema } from '../file-visibility.js';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';

const QuotaResponse = v.pipe(
	v.object({
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
		canUseDownloadCount: v.boolean(),
	}),
	v.metadata({ ref: 'Quota' }),
);
const EffectiveQuotaSource = v.picklist(['plan', 'custom', 'global', 'default']);
const EffectiveQuotaResponse = v.pipe(
	v.object({
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
		canUseDownloadCount: v.boolean(),
		effectiveQuotaExpiresAt: v.nullable(v.number()),
		effectiveQuotaUpdatedAt: v.nullable(v.number()),
		effectiveQuotaSource: v.nullable(EffectiveQuotaSource),
	}),
	v.metadata({ ref: 'EffectiveQuota' }),
);
const UserCustomQuotaResponse = v.pipe(
	v.object({
		exists: v.boolean(),
		quota: QuotaResponse,
	}),
	v.metadata({ ref: 'UserCustomQuota' }),
);
const QuotaInput = {
	maxBuckets: v.optional(v.nullable(v.number())),
	maxBucketSizeBytes: v.optional(v.nullable(v.number())),
	maxFilesPerBucket: v.optional(v.nullable(v.number())),
	maxDailyUploads: v.optional(v.nullable(v.number())),
	canUseDownloadCount: v.optional(v.boolean()),
} as const;
const PlanResponse = v.pipe(
	v.object({
		id: IdString,
		name: v.string(),
		maxBuckets: v.nullable(v.number()),
		maxBucketSizeBytes: v.nullable(v.number()),
		maxFilesPerBucket: v.nullable(v.number()),
		maxDailyUploads: v.nullable(v.number()),
		canUseDownloadCount: v.boolean(),
		isEnabled: v.boolean(),
		sortOrder: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'Plan' }),
);
const UserPlanAssignmentResponse = v.pipe(
	v.object({
		userId: IdString,
		planId: IdString,
		planName: v.string(),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'UserPlanAssignment' }),
);
const NullableUserPlanAssignmentResponse = v.nullable(UserPlanAssignmentResponse);
const IpBanResponse = v.pipe(
	v.object({
		id: IdString,
		cidr: v.string(),
		reason: v.nullable(v.string()),
		sourceEventId: v.nullable(v.string()),
		createdBy: v.nullable(v.string()),
		createdByUsername: v.nullable(v.string()),
		expiresAt: v.nullable(v.number()),
		createdAt: v.number(),
	}),
	v.metadata({ ref: 'IpBan' }),
);
const FileReportResponse = v.pipe(
	v.object({
		id: IdString,
		fileId: IdString,
		bucketName: v.nullable(v.string()),
		filePath: v.nullable(v.string()),
		fileSize: v.nullable(v.number()),
		fileMimeType: v.nullable(v.string()),
		fileOwnerId: v.nullable(v.string()),
		fileOwnerUsername: v.nullable(v.string()),
		reporterUserId: v.nullable(v.string()),
		reporterName: v.string(),
		reporterEmail: v.nullable(v.string()),
		reasonId: fileReportReasonSchema,
		relationshipId: fileReportRelationshipSchema,
		contact: v.nullable(v.string()),
		summary: v.string(),
		detail: v.string(),
		status: fileReportStatusSchema,
		adminNote: v.string(),
		reporterIpAddress: v.nullable(v.string()),
		reporterUserAgent: v.nullable(v.string()),
		uploadEventId: v.nullable(v.string()),
		uploadIpAddress: v.nullable(v.string()),
		uploadUserAgent: v.nullable(v.string()),
		uploadedAt: v.nullable(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
	v.metadata({ ref: 'FileReport' }),
);
const AdminFileResponse = v.pipe(
	v.object({
		id: IdString,
		bucketId: IdString,
		bucketName: v.nullable(v.string()),
		userId: IdString,
		ownerUsername: v.nullable(v.string()),
		path: v.string(),
		size: v.nullable(v.number()),
		mimeType: v.nullable(v.string()),
		visibility: fileVisibilitySchema,
		isListed: v.boolean(),
		isModerationForcedPrivate: v.boolean(),
		isClosed: v.boolean(),
		isTargz: v.boolean(),
		isTar: v.boolean(),
		createdAt: v.number(),
	}),
	v.metadata({ ref: 'AdminFile' }),
);
const ModerationAuditLogResponse = v.pipe(
	v.object({
		id: IdString,
		adminUserId: v.nullable(IdString),
		adminUsername: v.nullable(v.string()),
		action: v.string(),
		targetFileId: v.nullable(v.string()),
		targetUserId: v.nullable(v.string()),
		targetUsername: v.nullable(v.string()),
		data: v.nullable(v.record(v.string(), v.unknown())),
		createdAt: v.number(),
	}),
	v.metadata({ ref: 'ModerationAuditLog' }),
);
const AdminUserResponse = v.pipe(
	v.object({
		id: IdString,
		username: v.string(),
		isAdmin: v.boolean(),
		isSuspended: v.boolean(),
	}),
	v.metadata({ ref: 'AdminUser' }),
);

const OkResponse = { 200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } } };
const WorkerCachePurgeResponse = v.pipe(
	v.object({
		ok: v.literal(true),
		version: v.string(),
	}),
	v.metadata({ ref: 'WorkerCachePurgeResponse' }),
);
const AdminErrors = {};
const MissingUserId = errorResponse('Bad request (missing userId)', ['USER_ID_IS_REQUIRED']);
const UserNotFound = errorResponse('User not found', ['USER_NOT_FOUND']);
const PlanNotFound = errorResponse('Plan not found', ['PLAN_NOT_FOUND']);

export const adminApiDef = {
	'/api/admin/suspend-user': {
		summary: 'Suspend a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: MissingUserId, 404: UserNotFound },
	},
	'/api/admin/unsuspend-user': {
		summary: 'Unsuspend a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: MissingUserId, 404: UserNotFound },
	},
	'/api/admin/make-admin': {
		summary: 'Make a user an admin',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: MissingUserId, 404: UserNotFound },
	},
	'/api/admin/delete-file': {
		summary: 'Delete a file',
		tags: ['admin'],
		req: v.object({ fileId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: errorResponse('Bad request (missing fileId)', ['FILE_ID_IS_REQUIRED']), 404: errorResponse('File not found', ['FILE_NOT_FOUND']) },
	},
	'/api/admin/list-files': {
		summary: 'List all files',
		tags: ['admin'],
		req: v.object(PageRequestFields),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(AdminFileResponse) } } }, ...AdminErrors },
	},
	'/api/admin/list-moderation-audit-logs': {
		summary: 'List moderation audit logs',
		tags: ['admin'],
		req: v.object(PageRequestFields),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(ModerationAuditLogResponse) } } }, ...AdminErrors },
	},
	'/api/admin/update-file-moderation': {
		summary: 'Update file moderation flags',
		tags: ['admin'],
		req: v.object({
			fileId: IdString,
			isModerationForcedPrivate: v.boolean(),
		}),
		res: { ...OkResponse, ...AdminErrors, 404: errorResponse('File not found', ['FILE_NOT_FOUND']) },
	},
	'/api/admin/delete-bucket': {
		summary: 'Delete a bucket',
		tags: ['admin'],
		req: v.object({ bucketId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 400: errorResponse('Bad request (missing bucketId)', ['BUCKET_NOT_FOUND']), 404: errorResponse('Bucket not found', ['BUCKET_NOT_FOUND']) },
	},
	'/api/admin/purge-worker-cache': {
		summary: 'Purge Worker cache',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: WorkerCachePurgeResponse } } }, ...AdminErrors },
	},
	'/api/admin/set-user-quota': {
		summary: 'Set quota for a user',
		tags: ['admin'],
		req: v.object({
			userId: IdString,
			...QuotaInput,
		}),
		res: { ...OkResponse, ...AdminErrors, 404: UserNotFound },
	},
	'/api/admin/set-global-quota': {
		summary: 'Set global quota',
		tags: ['admin'],
		req: v.object(QuotaInput),
		res: { ...OkResponse, ...AdminErrors },
	},
	'/api/admin/get-user-quota': {
		summary: 'Get quota for a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: QuotaResponse } } }, ...AdminErrors, 404: UserNotFound },
	},
	'/api/admin/get-user-effective-quota': {
		summary: 'Get stored effective quota for a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: EffectiveQuotaResponse } } }, ...AdminErrors, 404: UserNotFound },
	},
	'/api/admin/recalculate-user-effective-quota': {
		summary: 'Recalculate effective quota for a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: EffectiveQuotaResponse } } }, ...AdminErrors, 404: UserNotFound },
	},
	'/api/admin/get-user-custom-quota': {
		summary: 'Get custom quota for a user',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: UserCustomQuotaResponse } } }, ...AdminErrors, 404: UserNotFound },
	},
	'/api/admin/get-global-quota': {
		summary: 'Get global quota',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: QuotaResponse } } }, ...AdminErrors },
	},
	'/api/admin/delete-user-quota': {
		summary: 'Delete user quota (reset to global)',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 404: UserNotFound },
	},
	'/api/admin/list-users': {
		summary: 'List all users',
		tags: ['admin'],
		req: v.object(PageRequestFields),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(AdminUserResponse) } } }, ...AdminErrors },
	},
	'/api/admin/update-setting': {
		summary: 'Update app setting',
		tags: ['admin'],
		req: KnownSettingRecordSchema,
		res: { ...OkResponse, ...AdminErrors, 400: errorResponse('Bad request (unknown setting key or invalid value)', ['INVALID_FILE_PATH']) },
	},
	'/api/admin/get-settings': {
		summary: 'Get all app settings',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: KnownSettingListSchema } } }, ...AdminErrors },
	},
	'/api/admin/list-ip-bans': {
		summary: 'List IP bans',
		tags: ['admin'],
		req: v.object(PageRequestFields),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(IpBanResponse) } } }, ...AdminErrors },
	},
	'/api/admin/create-ip-ban': {
		summary: 'Create an IP ban',
		tags: ['admin'],
		req: v.object({
			cidr: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
			reason: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(500)))),
			sourceEventId: v.optional(v.nullable(IdString)),
			expiresAt: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
		}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: IpBanResponse } } }, ...AdminErrors, 400: errorResponse('Bad request (invalid CIDR)', ['INVALID_CIDR']) },
	},
	'/api/admin/delete-ip-ban': {
		summary: 'Delete an IP ban',
		tags: ['admin'],
		req: v.object({ banId: IdString }),
		res: { ...OkResponse, ...AdminErrors },
	},
	'/api/admin/list-file-reports': {
		summary: 'List file reports',
		tags: ['admin'],
		req: v.object({ status: v.optional(v.nullable(fileReportStatusSchema)), ...PageRequestFields }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: pagedResponse(FileReportResponse) } } }, ...AdminErrors },
	},
	'/api/admin/get-file-report': {
		summary: 'Get file report',
		tags: ['admin'],
		req: v.object({ reportId: IdString }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: FileReportResponse } } }, ...AdminErrors, 404: errorResponse('File report not found', ['FILE_REPORT_NOT_FOUND']) },
	},
	'/api/admin/update-file-report': {
		summary: 'Update file report moderation status',
		tags: ['admin'],
		req: v.object({
			reportId: IdString,
			status: fileReportStatusSchema,
			adminNote: v.pipe(v.string(), v.maxLength(4000)),
		}),
		res: { ...OkResponse, ...AdminErrors, 404: errorResponse('File report not found', ['FILE_REPORT_NOT_FOUND']) },
	},
	'/api/admin/list-plans': {
		summary: 'List plans',
		tags: ['admin'],
		req: v.object({}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: v.array(PlanResponse) } } }, ...AdminErrors },
	},
	'/api/admin/create-plan': {
		summary: 'Create plan',
		tags: ['admin'],
		req: v.object({
			name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
			...QuotaInput,
			isEnabled: v.optional(v.boolean(), true),
			sortOrder: v.optional(v.pipe(v.number(), v.integer())),
		}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PlanResponse } } }, ...AdminErrors },
	},
	'/api/admin/update-plan': {
		summary: 'Update plan',
		tags: ['admin'],
		req: v.object({
			planId: IdString,
			name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
			...QuotaInput,
			isEnabled: v.optional(v.boolean(), true),
			sortOrder: v.optional(v.pipe(v.number(), v.integer())),
		}),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: PlanResponse } } }, ...AdminErrors, 404: PlanNotFound },
	},
	'/api/admin/assign-user-plan': {
		summary: 'Assign plan to user',
		tags: ['admin'],
		req: v.object({
			userId: IdString,
			planId: IdString,
			expiresAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
		}),
		res: { ...OkResponse, ...AdminErrors, 404: errorResponse('User or plan not found', ['USER_NOT_FOUND', 'PLAN_NOT_FOUND']) },
	},
	'/api/admin/get-user-plan': {
		summary: 'Get user plan assignment',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { 200: { description: 'Success', content: { 'application/json': { vSchema: NullableUserPlanAssignmentResponse } } }, ...AdminErrors, 404: UserNotFound },
	},
	'/api/admin/delete-user-plan': {
		summary: 'Delete user plan assignment',
		tags: ['admin'],
		req: v.object({ userId: IdString }),
		res: { ...OkResponse, ...AdminErrors, 404: UserNotFound },
	},
} as const satisfies ApiEndpointDefinitionRecord;
