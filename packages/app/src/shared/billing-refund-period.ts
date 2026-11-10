export type BillingPlanPeriod = {
	startsAt: number;
	expiresAt: number;
};

export type BillingRefundPeriod = {
	retainedPeriod: BillingPlanPeriod | null;
	cancelledPeriod: BillingPlanPeriod | null;
};

/**
 * Split an entitlement's half-open period at the refund cutoff.
 * This is a preview only: it neither prices a refund nor mutates an assignment.
 * Use stored timestamps, including UTC calendar month/year boundaries, rather
 * than reconstructing the purchased duration from today's prices.
 */
export function splitBillingRefundPeriod(period: BillingPlanPeriod, cutoffAt: number): BillingRefundPeriod {
	if (
		!Number.isSafeInteger(period.startsAt)
		|| !Number.isSafeInteger(period.expiresAt)
		|| !Number.isSafeInteger(cutoffAt)
		|| !Number.isSafeInteger(period.expiresAt - period.startsAt)
		|| period.expiresAt <= period.startsAt
	) throw new RangeError('Invalid billing period or refund cutoff');

	if (cutoffAt <= period.startsAt) {
		return { retainedPeriod: null, cancelledPeriod: { ...period } };
	}
	if (cutoffAt >= period.expiresAt) {
		return { retainedPeriod: { ...period }, cancelledPeriod: null };
	}
	return {
		retainedPeriod: { startsAt: period.startsAt, expiresAt: cutoffAt },
		cancelledPeriod: { startsAt: cutoffAt, expiresAt: period.expiresAt },
	};
}
