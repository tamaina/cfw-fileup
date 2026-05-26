import { describe, expect, test } from 'vitest';
import { addPaymentDuration, calculatePaymentQuote } from '../src/shared/billing-quote';

describe('billing quote calculation', () => {
	const baseAt = Date.UTC(2026, 0, 15, 12, 0, 0);

	test('extends the current expiry when buying the same plan again', () => {
		const currentExpiresAt = baseAt + 30 * 86_400_000;
		const quote = calculatePaymentQuote({
			quoteCreatedAt: baseAt,
			quoteTtlMs: 15 * 60 * 1000,
			targetPlanId: 'plan-basic',
			targetPlanPrice: {
				amountBaseUnits: '30000000',
				durationDays: 90,
				durationUnit: 'days',
			},
			currentPlan: {
				id: 'plan-basic',
				name: 'Basic',
				expiresAt: currentExpiresAt,
				price: {
					amountBaseUnits: '30000000',
					durationDays: 90,
					durationUnit: 'days',
				},
			},
		});

		expect(quote.discountBaseUnits).toBe('0');
		expect(quote.payableAmountBaseUnits).toBe('30000000');
		expect(quote.effectiveExpiresAt).toBe(currentExpiresAt + 90 * 86_400_000);
	});

	test('does not discount when there is no current active plan', () => {
		const quote = calculatePaymentQuote({
			quoteCreatedAt: baseAt,
			quoteTtlMs: 15 * 60 * 1000,
			targetPlanId: 'plan-basic',
			targetPlanPrice: {
				amountBaseUnits: '30000000',
				durationDays: 90,
				durationUnit: 'days',
			},
			currentPlan: null,
		});

		expect(quote.discountBaseUnits).toBe('0');
		expect(quote.payableAmountBaseUnits).toBe('30000000');
		expect(quote.currentPlan).toBeNull();
	});

	test('discounts an upgrade by the remaining value of the current plan', () => {
		const quote = calculatePaymentQuote({
			quoteCreatedAt: baseAt,
			quoteTtlMs: 15 * 60 * 1000,
			targetPlanId: 'plan-pro',
			targetPlanPrice: {
				amountBaseUnits: '90000000',
				durationDays: 90,
				durationUnit: 'days',
			},
			currentPlan: {
				id: 'plan-basic',
				name: 'Basic',
				expiresAt: baseAt + 30 * 86_400_000,
				price: {
					amountBaseUnits: '30000000',
					durationDays: 90,
					durationUnit: 'days',
				},
			},
		});

		expect(quote.baseAmountBaseUnits).toBe('90000000');
		expect(quote.discountBaseUnits).toBe('10000000');
		expect(quote.payableAmountBaseUnits).toBe('80000000');
		expect(quote.effectiveExpiresAt).toBe(baseAt + 90 * 86_400_000);
		expect(quote.currentPlan).toEqual(expect.objectContaining({ id: 'plan-basic' }));
	});

	test('adds calendar months without overflowing into the next month', () => {
		const jan31 = Date.UTC(2026, 0, 31, 10, 0, 0);

		expect(addPaymentDuration(jan31, 1, 'months')).toBe(Date.UTC(2026, 1, 28, 10, 0, 0));
	});
});
