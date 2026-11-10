/** A persisted purchase snapshot, never the customer's currently linked wallet. */
export type BillingRefundSourceOrder = {
	id: string;
	payerAddress: string;
	chainId: number;
	contractAddress: string;
	decimals: number;
};

export type BillingRefundLine = {
	id: string;
	assignmentId: string;
	sourceOrder: BillingRefundSourceOrder;
	/** Already calculated by the server's refund policy, including credit provenance. */
	amountBaseUnits: string;
};

export type BillingRefundGroup = {
	payerAddress: string;
	chainId: number;
	contractAddress: string;
	decimals: number;
	amountBaseUnits: string;
	lines: BillingRefundLine[];
};

/**
 * Group allocated amounts by original payer and settlement rail.
 * This neither calculates refunds nor decides when an entitlement can expire.
 * Retaining source lines permits multiple original payers to fund one assignment.
 */
export function groupBillingRefundLines(lines: readonly BillingRefundLine[]): BillingRefundGroup[] {
	const groups = new Map<string, BillingRefundGroup>();
	const lineIds = new Set<string>();
	const sourceRails = new Map<string, string>();
	for (const line of lines) {
		const source = line.sourceOrder;
		if (!line.id || !line.assignmentId || !source.id || lineIds.has(line.id)) {
			throw new TypeError('Missing refund provenance or duplicate refund line');
		}
		if (
			!Number.isSafeInteger(source.chainId) || source.chainId <= 0
			|| !Number.isSafeInteger(source.decimals) || source.decimals < 0 || source.decimals > 255
			|| !/^0x[a-fA-F0-9]{40}$/.test(source.payerAddress)
			|| !/^0x[a-fA-F0-9]{40}$/.test(source.contractAddress)
			|| !/^(0|[1-9]\d*)$/.test(line.amountBaseUnits)
		) throw new TypeError('Invalid refund settlement rail or base units');
		lineIds.add(line.id);
		const payerAddress = source.payerAddress.toLowerCase();
		const contractAddress = source.contractAddress.toLowerCase();
		const key = `${payerAddress}:${source.chainId}:${contractAddress}:${source.decimals}`;
		const previousRail = sourceRails.get(source.id);
		if (previousRail !== undefined && previousRail !== key) {
			throw new TypeError('Conflicting original purchase snapshot');
		}
		sourceRails.set(source.id, key);
		const group = groups.get(key) ?? {
			payerAddress,
			chainId: source.chainId,
			contractAddress,
			decimals: source.decimals,
			amountBaseUnits: '0',
			lines: [],
		};
		group.amountBaseUnits = (BigInt(group.amountBaseUnits) + BigInt(line.amountBaseUnits)).toString();
		group.lines.push({ ...line, sourceOrder: { ...source } });
		groups.set(key, group);
	}
	return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => ({
		...group,
		lines: group.lines.sort((a, b) => a.id.localeCompare(b.id)),
	}));
}
