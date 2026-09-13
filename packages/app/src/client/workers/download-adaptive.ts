type Window = { start: number; bytes: number; samples: number };

/** Network is always serial. Only the shared CPU pool is tuned. */
export class AdaptiveDownloadConcurrency {
	readonly network = 1;
	cpu = 1;
	private windows = new Map<string, Window>();
	private trial: { kind: string; before: number; rate: number } | undefined;
	private cooldownUntil = 0;
	private networkRate = 0;
	private seeded = false;
	private cpuRates = new Map<string, number>();
	constructor(public limit: number, public hardware: number) {}
	get cpuLimit(): number { return Math.max(1, Math.min(this.limit, this.hardware, 8)); }
	clamp(): void { this.cpu = Math.min(this.cpu, this.cpuLimit); }
	sample(stage: 'network' | 'cpu', bytes: number, durationMs: number, now: number, pressure: { cpu: boolean; network?: boolean }, kind = '', comparable = false): void {
		if (bytes <= 0 || durationMs <= 0) return;
		const rate = bytes / durationMs;
		if (stage === 'network') {
			this.networkRate = this.networkRate ? this.networkRate * 0.75 + rate * 0.25 : rate;
			return;
		}
		const previous = this.cpuRates.get(kind);
		const cpuRate = previous === undefined ? rate : previous * 0.75 + rate * 0.25;
		this.cpuRates.set(kind, cpuRate);
		if (!this.seeded && !this.trial && comparable && this.networkRate) {
			this.cpu = Math.min(this.cpuLimit, Math.max(1, Math.ceil(this.networkRate / cpuRate)));
			this.seeded = true;
		}
		// Compare the same CPU stage's input throughput, excluding cross-format byte ratios.
		const window = this.windows.get(kind) ?? { start: now - durationMs, bytes: 0, samples: 0 };
		this.windows.set(kind, window);
		window.bytes += bytes; window.samples++;
		if (now - window.start < 2000 || window.samples < 3) return;
		const throughput = window.bytes / (now - window.start);
		this.windows.set(kind, { start: now, bytes: 0, samples: 0 });
		if (this.trial) {
			if (this.trial.kind !== kind) return;
			if (throughput < this.trial.rate * 1.1) this.cpu = this.trial.before;
			this.trial = undefined;
			this.cooldownUntil = now + 5000;
			this.clamp();
			return;
		}
		if (now >= this.cooldownUntil && pressure.cpu && this.cpu < this.cpuLimit) {
			this.trial = { kind, before: this.cpu, rate: throughput };
			this.cpu++;
		}
	}
}
