export type PaymentDurationUnit = 'days' | 'months' | 'years';

export type PaymentQuotePlanPrice = {
	amountBaseUnits: string;
	durationDays: number;
	durationUnit: PaymentDurationUnit;
};

export type PaymentQuoteCurrentPlan = {
	id: string;
	name: string;
	expiresAt: number;
	price: PaymentQuotePlanPrice;
};

export type PaymentQuoteInput = {
	quoteCreatedAt: number;
	quoteTtlMs: number;
	targetPlanId: string;
	targetPlanPrice: PaymentQuotePlanPrice;
	currentPlan: PaymentQuoteCurrentPlan | null;
};

export type PaymentQuote = {
	quoteCreatedAt: number;
	quoteExpiresAt: number;
	baseAmountBaseUnits: string;
	discountBaseUnits: string;
	payableAmountBaseUnits: string;
	effectiveExpiresAt: number;
	currentPlan: {
		id: string;
		name: string;
		expiresAt: number;
		priceAmountBaseUnits: string;
		priceDurationDays: number;
		priceDurationUnit: PaymentDurationUnit;
	} | null;
};

export const DAY_MS = 86_400_000;

export function addPaymentDuration(baseMs: number, value: number, unit: PaymentDurationUnit): number {
	if (unit === 'days') return baseMs + value * DAY_MS;

	const base = new Date(baseMs);
	const year = base.getUTCFullYear();
	const month = base.getUTCMonth();
	const day = base.getUTCDate();
	const targetMonthIndex = unit === 'months' ? month + value : month + value * 12;
	const targetYear = year + Math.floor(targetMonthIndex / 12);
	const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
	const targetDay = Math.min(day, getUtcDaysInMonth(targetYear, targetMonth));
	return Date.UTC(
		targetYear,
		targetMonth,
		targetDay,
		base.getUTCHours(),
		base.getUTCMinutes(),
		base.getUTCSeconds(),
		base.getUTCMilliseconds(),
	);
}

export function calculatePaymentQuote(input: PaymentQuoteInput): PaymentQuote {
	const baseAmount = BigInt(input.targetPlanPrice.amountBaseUnits);
	const samePlan = input.currentPlan?.id === input.targetPlanId;
	const effectiveBaseAt = samePlan && input.currentPlan ? input.currentPlan.expiresAt : input.quoteCreatedAt;
	const effectiveExpiresAt = addPaymentDuration(effectiveBaseAt, input.targetPlanPrice.durationDays, input.targetPlanPrice.durationUnit);

	if (!input.currentPlan || samePlan) {
		return {
			quoteCreatedAt: input.quoteCreatedAt,
			quoteExpiresAt: input.quoteCreatedAt + input.quoteTtlMs,
			baseAmountBaseUnits: input.targetPlanPrice.amountBaseUnits,
			discountBaseUnits: '0',
			payableAmountBaseUnits: input.targetPlanPrice.amountBaseUnits,
			effectiveExpiresAt,
			currentPlan: null,
		};
	}

	const remainingMs = Math.max(0, input.currentPlan.expiresAt - input.quoteCreatedAt);
	const currentDurationMs = Math.max(1, addPaymentDuration(input.quoteCreatedAt, input.currentPlan.price.durationDays, input.currentPlan.price.durationUnit) - input.quoteCreatedAt);
	const rawDiscount = BigInt(input.currentPlan.price.amountBaseUnits) * BigInt(remainingMs) / BigInt(currentDurationMs);
	const discount = rawDiscount > baseAmount ? baseAmount : rawDiscount;

	return {
		quoteCreatedAt: input.quoteCreatedAt,
		quoteExpiresAt: input.quoteCreatedAt + input.quoteTtlMs,
		baseAmountBaseUnits: input.targetPlanPrice.amountBaseUnits,
		discountBaseUnits: discount.toString(),
		payableAmountBaseUnits: (baseAmount - discount).toString(),
		effectiveExpiresAt,
		currentPlan: {
			id: input.currentPlan.id,
			name: input.currentPlan.name,
			expiresAt: input.currentPlan.expiresAt,
			priceAmountBaseUnits: input.currentPlan.price.amountBaseUnits,
			priceDurationDays: input.currentPlan.price.durationDays,
			priceDurationUnit: input.currentPlan.price.durationUnit,
		},
	};
}

function getUtcDaysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
