import { describe, expect, test } from 'vitest';
import { fundingIntervalAmount } from '../src/shared/billing-funding';

describe('immutable original cash funding basis', () => {
	const basis = { basisAmountBaseUnits: '101', basisStartsAt: 100, basisExpiresAt: 200, startsAt: 100, expiresAt: 200 };
	test('refunds cash rather than a current plan price and floors base units', () => {
		expect(fundingIntervalAmount(basis, 150, 200)).toBe(50n);
	});
	test('shrinking a retained interval never changes the denominator', () => {
		const retained = { ...basis, expiresAt: 150 };
		expect(fundingIntervalAmount(retained, 125, 150)).toBe(25n);
	});
	test('split credit and retained cash cannot exceed original cash', () => {
		const intervals = [[100, 133], [133, 166], [166, 200]];
		const values = intervals.map(([from, to]) => fundingIntervalAmount(basis, from, to));
		expect(values.reduce((sum, amount) => sum + amount, 0n)).toBeLessThanOrEqual(101n);
	});
	test('never refunds consumed or inactive bounds', () => {
		const retained = { ...basis, startsAt: 125, expiresAt: 175 };
		expect(fundingIntervalAmount(retained, 0, 1000)).toBe(50n);
		expect(fundingIntervalAmount(retained, 200, 300)).toBe(0n);
	});
	test('handles base units larger than JavaScript integers', () => {
		expect(fundingIntervalAmount({ ...basis, basisAmountBaseUnits: '900719925474099300' }, 150, 200)).toBe(450359962737049650n);
	});
	test('zero payable is representable without losing its original-order lineage', () => {
		expect(fundingIntervalAmount({ ...basis, basisAmountBaseUnits: '0' }, 100, 200)).toBe(0n);
	});
	test('rejects invalid financial basis', () => {
		expect(() => fundingIntervalAmount({ ...basis, basisExpiresAt: 100 }, 100, 200)).toThrow(RangeError);
		expect(() => fundingIntervalAmount({ ...basis, basisAmountBaseUnits: '-1' }, 100, 200)).toThrow(TypeError);
	});
});
