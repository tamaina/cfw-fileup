import { gt, isNull, or } from 'drizzle-orm';
import { genEaidx } from '../../shared/eaid-x';
import { ipBans, moderationAuditLogs, moderationEvents } from '../scheme/index';
import { apiError } from './api-error';
import { getDb } from './db';
import { getRequestIp } from './request-ip';
import { ipMatchesCidr } from './cidr';
import type { Context } from 'hono';

export type ModerationAction =
	| 'user_token_created'
	| 'file_uploaded'
	| 'file_renamed'
	| 'file_deleted'
	| 'file_token_created'
	| 'crypto_payment_order_confirmed';

export type ModerationAuditAction =
	| 'admin_user_suspended'
	| 'admin_user_unsuspended'
	| 'admin_user_made_admin'
	| 'admin_ip_ban_created'
	| 'admin_ip_ban_deleted'
	| 'admin_file_report_updated'
	| 'admin_file_deleted'
	| 'admin_bucket_deleted'
	| 'admin_worker_cache_purged'
	| 'admin_user_quota_set'
	| 'admin_user_quota_recalculated'
	| 'admin_global_quota_set'
	| 'admin_user_quota_deleted'
	| 'admin_setting_updated'
	| 'admin_plan_created'
	| 'admin_plan_updated'
	| 'admin_user_plan_assigned'
	| 'admin_user_plan_deleted'
	| 'admin_payment_chain_created'
	| 'admin_payment_chain_updated'
	| 'admin_payment_chain_deleted'
	| 'admin_payment_asset_created'
	| 'admin_payment_asset_updated'
	| 'admin_payment_asset_deleted'
	| 'admin_payment_deployment_created'
	| 'admin_payment_deployment_updated'
	| 'admin_payment_price_created'
	| 'admin_payment_price_updated'
	| 'admin_payment_price_deleted'
	| 'admin_crypto_payment_order_confirmed'
	| 'admin_file_previewed'
	| 'admin_file_moderation_forced_private_updated';

export async function recordModerationEvent(
	c: Context<{ Bindings: Env }>,
	action: ModerationAction,
	data: Record<string, unknown> | null = null,
	userId?: string | null,
	userTokenId?: string | null,
): Promise<void> {
	const db = getDb(c.env);
	await db.insert(moderationEvents).values({
		id: genEaidx(Date.now()),
		userId: userId ?? null,
		userTokenId: userTokenId ?? null,
		action,
		ipAddress: getRequestIp(c.req),
		userAgent: c.req.header('User-Agent') ?? null,
		data,
	});
}

export async function recordModerationAuditLog(
	c: Context<{ Bindings: Env }>,
	action: ModerationAuditAction,
	options: {
		targetFileId?: string | null;
		targetUserId?: string | null;
		data?: Record<string, unknown> | null;
	} = {},
): Promise<void> {
	const db = getDb(c.env);
	const user = c.get('user');
	await db.insert(moderationAuditLogs).values({
		id: genEaidx(Date.now()),
		adminUserId: user.id,
		action,
		targetFileId: options.targetFileId ?? null,
		targetUserId: options.targetUserId ?? null,
		data: options.data ?? null,
	});
}

export async function rejectIpBan(c: Context<{ Bindings: Env }>): Promise<void> {
	const ipAddress = getRequestIp(c.req);
	if (!ipAddress) return;

	const db = getDb(c.env);
	const rows = await db
		.select({ cidr: ipBans.cidr })
		.from(ipBans)
		.where(or(isNull(ipBans.expiresAt), gt(ipBans.expiresAt, Date.now())));

	for (const row of rows) {
		if (ipMatchesCidr(ipAddress, row.cidr)) {
			throw apiError(403, 'IP_BANNED');
		}
	}
}
