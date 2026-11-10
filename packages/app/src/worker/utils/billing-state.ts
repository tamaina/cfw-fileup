import { eq } from 'drizzle-orm';
import { billingStates } from '../scheme';
import { genEaidx } from '../../shared/eaid-x';
import { getDb } from './db';
import { apiError } from './api-error';

export function billingErrorContains(error: unknown, message: string): boolean {
	let current = error;
	for (let depth = 0; depth < 5 && current !== undefined; depth++) {
		if (String(current).includes(message)) return true;
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

export async function getBillingState(env: Env, userId: string) {
	const db = getDb(env);
	await db.insert(billingStates).values({ userId }).onConflictDoNothing();
	const state = await db.select().from(billingStates).where(eq(billingStates.userId, userId)).get();
	if (!state) throw apiError(409, 'REFUND_CONFLICT');
	return state;
}

export function prepareBillingQuery(env: Env, query: { toSQL(): { sql: string; params: unknown[] } }): D1PreparedStatement {
	const { sql, params } = query.toSQL();
	return env.DB.prepare(sql).bind(...params);
}

/** Guard failure is a CHECK error, rolling back every subsequent batch write. */
export async function commitBillingBatch(env: Env, options: {
	userId: string; revision: number; lockRequestId: string | null;
	condition?: string; conditionParams?: unknown[]; statements: D1PreparedStatement[];
	conditions?: Array<{ sql: string; params: unknown[] }>;
}): Promise<void> {
	const id = genEaidx(Date.now());
	const guard = env.DB.prepare(`INSERT INTO billing_guards (id, valid) VALUES (?, CASE WHEN
		EXISTS (SELECT 1 FROM billing_states WHERE user_id = ? AND revision = ? AND lock_request_id IS ?)
		AND (${options.condition ?? '1'}) THEN 1 ELSE 0 END)`)
		.bind(id, options.userId, options.revision, options.lockRequestId, ...(options.conditionParams ?? []));
	const extra = (options.conditions ?? []).map(condition => ({
		id: genEaidx(Date.now()), ...condition,
	}));
	const extraGuards = extra.map(condition => env.DB.prepare(`INSERT INTO billing_guards (id, valid) VALUES (?, CASE WHEN (${condition.sql}) THEN 1 ELSE 0 END)`).bind(condition.id, ...condition.params));
	try {
		await env.DB.batch([guard, ...extraGuards, ...options.statements,
																						env.DB.prepare('DELETE FROM billing_guards WHERE id = ?').bind(id),
																						...extra.map(condition => env.DB.prepare('DELETE FROM billing_guards WHERE id = ?').bind(condition.id)),
		]);
	} catch (error) {
		if (billingErrorContains(error, 'billing_guard_valid') || billingErrorContains(error, 'UNIQUE constraint failed')) {
			throw apiError(409, 'REFUND_CONFLICT', '課金状態が変更されました。既存の処理を再確認してください。');
		}
		throw error;
	}
}
