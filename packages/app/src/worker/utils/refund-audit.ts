import { moderationAuditLogs } from '../scheme';
import { genEaidx } from '../../shared/eaid-x';
import { getDb } from './db';
import { prepareBillingQuery } from './billing-state';

export function refundAuditStatement(env: Env, actorId: string, userId: string, requestId: string, action: string) {
	return prepareBillingQuery(env, getDb(env).insert(moderationAuditLogs).values({
		id: genEaidx(Date.now()), adminUserId: actorId, targetUserId: userId,
		action, data: { requestId },
	}));
}
