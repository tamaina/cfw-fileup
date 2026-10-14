import { describe, expect, test } from 'vitest';
import { groupBillingRefundLines, type BillingRefundLine } from '../src/shared/billing-refund-groups';

describe('refund groups from original purchases', () => {
	const payerA = `0x${'a'.repeat(40)}`;
	const payerB = `0x${'b'.repeat(40)}`;
	const tokenA = `0x${'c'.repeat(40)}`;
	const tokenB = `0x${'d'.repeat(40)}`;
	const first: BillingRefundLine = {
		id: 'line-a', assignmentId: 'assignment-a', amountBaseUnits: '100',
		sourceOrder: { id: 'order-a', payerAddress: payerA, chainId: 1, contractAddress: tokenA, decimals: 6 },
	};
	const second: BillingRefundLine = {
		...first, id: 'line-b', amountBaseUnits: '200', sourceOrder: { ...first.sourceOrder, id: 'order-b' },
	};

	test('sums using BigInt and preserves original purchase references', () => {
		const groups = groupBillingRefundLines([
			{ ...first, amountBaseUnits: '9007199254740993' }, second,
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.amountBaseUnits).toBe('9007199254741193');
		expect(groups[0]?.lines.map(line => line.sourceOrder.id)).toEqual(['order-a', 'order-b']);
	});
	test('keeps contributions from different payers separate even for the same assignment', () => {
		const groups = groupBillingRefundLines([first, { ...second, sourceOrder: { ...second.sourceOrder, payerAddress: payerB } }]);
		expect(groups.map(group => [group.payerAddress, group.amountBaseUnits])).toEqual([[payerA, '100'], [payerB, '200']]);
		expect(groups.every(group => group.lines[0]?.assignmentId === first.assignmentId)).toBe(true);
	});
	test.each([
		{ chainId: 10 },
		{ contractAddress: tokenB },
		{ decimals: 18 },
	])('does not mix incompatible rails %o', difference => {
		expect(groupBillingRefundLines([first, { ...second, sourceOrder: { ...second.sourceOrder, ...difference } }])).toHaveLength(2);
	});
	test('normalizes address case and gives deterministic group and line ordering', () => {
		const changed = { ...second, sourceOrder: { ...second.sourceOrder, payerAddress: `0x${'A'.repeat(40)}`, contractAddress: `0x${'C'.repeat(40)}` } };
		expect(groupBillingRefundLines([changed, first])).toEqual(groupBillingRefundLines([first, changed]));
		expect(groupBillingRefundLines([changed, first])[0]?.amountBaseUnits).toBe('300');
	});
	test('keeps zero allocated amounts without implying any zero-amount completion policy', () => {
		expect(groupBillingRefundLines([{ ...first, amountBaseUnits: '0' }])[0]?.amountBaseUnits).toBe('0');
		expect(groupBillingRefundLines([])).toEqual([]);
	});
	test('rejects duplicate line IDs before any amount can be counted twice', () => {
		expect(() => groupBillingRefundLines([first, first])).toThrow(TypeError);
	});
	test('rejects changing the payer of the same original order between lines', () => {
		const changed = { ...second, sourceOrder: { ...first.sourceOrder, payerAddress: payerB } };
		expect(() => groupBillingRefundLines([first, changed])).toThrow(TypeError);
	});
	test.each(['-1', '1.5', '01', '1e6', ''])('rejects invalid allocated base units %s', amountBaseUnits => {
		expect(() => groupBillingRefundLines([{ ...first, amountBaseUnits }])).toThrow(TypeError);
	});
	test.each([
		{ id: '' }, { payerAddress: 'invalid' }, { contractAddress: 'invalid' },
		{ chainId: 0 }, { chainId: 1.5 }, { decimals: -1 }, { decimals: 256 },
	])('rejects invalid source provenance %o', difference => {
		expect(() => groupBillingRefundLines([{ ...first, sourceOrder: { ...first.sourceOrder, ...difference } }])).toThrow(TypeError);
	});
	test('returns independent snapshots', () => {
		const groups = groupBillingRefundLines([first]);
		const copied = groups[0].lines[0];
		copied.sourceOrder.payerAddress = payerB;
		expect(first.sourceOrder.payerAddress).toBe(payerA);
	});
});
