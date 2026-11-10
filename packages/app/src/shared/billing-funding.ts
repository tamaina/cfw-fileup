export type FundingBasis = {
	basisAmountBaseUnits: string;
	basisStartsAt: number;
	basisExpiresAt: number;
	startsAt: number;
	expiresAt: number;
};

/** Floor each unconsumed interval against its immutable original funding basis. */
export function fundingIntervalAmount(lot: FundingBasis, startsAt: number, expiresAt: number): bigint {
	const from = Math.max(startsAt, lot.startsAt, lot.basisStartsAt);
	const to = Math.min(expiresAt, lot.expiresAt, lot.basisExpiresAt);
	const duration = lot.basisExpiresAt - lot.basisStartsAt;
	if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
		throw new RangeError('Invalid funding interval');
	}
	if (!/^(0|[1-9]\d*)$/.test(lot.basisAmountBaseUnits)) throw new TypeError('Invalid funding basis');
	return to <= from ? 0n : BigInt(lot.basisAmountBaseUnits) * BigInt(to - from) / BigInt(duration);
}
