import { describe, expect, test } from 'vitest';
import { addPaymentDuration } from '../src/shared/billing-quote';
import { splitBillingRefundPeriod } from '../src/shared/billing-refund-period';

describe('billing refund cutoff preview', () => {
	const period = { startsAt: 100, expiresAt: 200 };

	test.each([0, 100])('cancels the whole future period at %s', cutoffAt => {
		expect(splitBillingRefundPeriod(period, cutoffAt)).toEqual({ retainedPeriod: null, cancelledPeriod: period });
	});
	test.each([200, 300])('keeps periods ending at or before %s', cutoffAt => {
		expect(splitBillingRefundPeriod(period, cutoffAt)).toEqual({ retainedPeriod: period, cancelledPeriod: null });
	});
	test('splits a crossing period without an overlap or gap', () => {
		expect(splitBillingRefundPeriod(period, 150)).toEqual({
			retainedPeriod: { startsAt: 100, expiresAt: 150 },
			cancelledPeriod: { startsAt: 150, expiresAt: 200 },
		});
		expect(period).toEqual({ startsAt: 100, expiresAt: 200 });
	});
	test('uses the original UTC calendar month boundary', () => {
		const startsAt = Date.UTC(2028, 0, 31, 12);
		const expiresAt = addPaymentDuration(startsAt, 1, 'months');
		const cutoffAt = Date.UTC(2028, 1, 15, 12);
		expect(splitBillingRefundPeriod({ startsAt, expiresAt }, cutoffAt).cancelledPeriod).toEqual({
			startsAt: cutoffAt,
			expiresAt: Date.UTC(2028, 1, 29, 12),
		});
	});
	test('partitions each original entitlement without changing total duration', () => {
		const periods = [
			{ startsAt: 100, expiresAt: 200 },
			{ startsAt: 200, expiresAt: 500 },
			{ startsAt: 1000, expiresAt: 2000 },
		];
		for (const cutoffAt of [0, 100, 150, 200, 350, 500, 1000, 1500, 2000, 3000]) {
			for (const original of periods) {
				const { retainedPeriod, cancelledPeriod } = splitBillingRefundPeriod(original, cutoffAt);
				const keptMs = retainedPeriod ? retainedPeriod.expiresAt - retainedPeriod.startsAt : 0;
				const cancelledMs = cancelledPeriod ? cancelledPeriod.expiresAt - cancelledPeriod.startsAt : 0;
				expect(keptMs + cancelledMs).toBe(original.expiresAt - original.startsAt);
				if (retainedPeriod) expect(retainedPeriod.expiresAt).toBeLessThanOrEqual(cutoffAt);
				if (cancelledPeriod) expect(cancelledPeriod.startsAt).toBeGreaterThanOrEqual(cutoffAt);
			}
		}
	});
	test('repeating a cutoff leaves an already retained period unchanged', () => {
		const { retainedPeriod } = splitBillingRefundPeriod(period, 150);
		expect(retainedPeriod).not.toBeNull();
		if (!retainedPeriod) throw new Error('Expected retained period');
		expect(splitBillingRefundPeriod(retainedPeriod, 150)).toEqual({ retainedPeriod, cancelledPeriod: null });
	});
	test.each([NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cutoff %s', cutoffAt => {
		expect(() => splitBillingRefundPeriod(period, cutoffAt)).toThrow(RangeError);
	});
	test.each([
		{ startsAt: 200, expiresAt: 100 },
		{ startsAt: 100, expiresAt: 100 },
		{ startsAt: NaN, expiresAt: 200 },
		{ startsAt: 100, expiresAt: Infinity },
		{ startsAt: -Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER },
	])('rejects invalid period %o', invalidPeriod => {
		expect(() => splitBillingRefundPeriod(invalidPeriod, 150)).toThrow(RangeError);
	});
});
