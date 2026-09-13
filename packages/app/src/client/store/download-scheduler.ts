import { watch } from 'vue';
import { AdaptiveDownloadConcurrency } from '../workers/download-adaptive';
import { DOWNLOAD_BUDGET_BYTES, LANE_BYTES, PIPELINE_WINDOW, PROCESS_JOB_BYTES, type ProcessingJob, type ProcessingResult, type SchedulerRequest, type SchedulerResponse } from '../workers/download-processing';
import { browserDownloadConcurrency } from './browser-download-settings';

type Session = { id: string; port: MessagePort; admitted: boolean; stopping?: boolean; startId?: number; queue: Array<{ jobId: number; job?: ProcessingJob }>; network: Set<number> };
type Slot = { worker: Worker; active?: { session: Session; jobId: number; job: ProcessingJob; inputBytes: number } };

/** One tab owns this broker. Buffers are transferred through the broker without cloning. */
export class DownloadScheduler {
	private sessions = new Map<string, Session>();
	private slots: Slot[] = [];
	private lastSession = { network: '', cpu: '' };
	private adaptive: AdaptiveDownloadConcurrency;
	private peakLanes = 0;
	private peakCpu = 0;
	private peakNetwork = 0;
	private cpuMs = 0;
	private networkMs = 0;
	private inputBytes = 0;
	constructor(limit: number, hardware: number, private makeWorker = () => new Worker(new URL('../workers/download-processing.worker.ts', import.meta.url), { type: 'module' })) {
		this.adaptive = new AdaptiveDownloadConcurrency(limit, Number.isSafeInteger(hardware) && hardware > 0 ? hardware : 1);
	}
	setLimit(limit: number): void {
		this.adaptive.limit = limit;
		this.adaptive.clamp();
		this.pump();
	}
	connect(id: string): MessagePort {
		const channel = new MessageChannel();
		const session: Session = { id, port: channel.port1, admitted: false, queue: [], network: new Set() };
		this.sessions.set(id, session);
		channel.port1.onmessage = (event: MessageEvent<SchedulerRequest>) => {
			if (!this.sessions.has(id)) return;
			const message = event.data;
			if (message.type === 'close') { this.close(id); return; }
			if (session.stopping) return;
			if (message.type === 'start') session.startId = message.jobId;
			if (message.type === 'network') session.queue.push({ jobId: message.jobId });
			if (message.type === 'process') {
				const active = this.slots.filter(slot => slot.active?.session === session).length;
				const queued = session.queue.filter(q => q.job !== undefined).length;
				if (message.job.bytes.buffer.byteLength > PROCESS_JOB_BYTES || message.job.outputBytes > PROCESS_JOB_BYTES
					|| queued + active >= 2 * PIPELINE_WINDOW) {
					this.fail(id, 'Download processing reservation exceeded');
					return;
				}
				session.queue.push({ jobId: message.jobId, job: message.job });
			}
			if (message.type === 'network-done' && session.network.delete(message.jobId)) {
				this.networkMs += message.durationMs;
				this.inputBytes += message.bytes;
				this.adaptive.sample('network', message.bytes, message.durationMs, performance.now(), this.pressure());
			}
			this.pump();
		};
		channel.port1.onmessageerror = () => this.close(id, 'Download scheduler message failed');
		return channel.port2;
	}
	private fail(id: string, error: string): void {
		const session = this.sessions.get(id);
		if (!session || session.stopping) return;
		session.stopping = true;
		session.queue.length = 0;
		this.send(session, { type: 'fatal', error });
		for (const slot of [...this.slots]) {
			if (slot.active?.session !== session) continue;
			slot.worker.terminate();
			this.slots.splice(this.slots.indexOf(slot), 1);
		}
		// The manager aborts HTTP and cleans OPFS before acknowledging close.
		// Keep its admission and network lease until then, including on worker failure.
		this.pump();
	}
	close(id: string, error?: string): void {
		const session = this.sessions.get(id);
		if (!session) return;
		if (error) this.send(session, { type: 'fatal', error });
		this.sessions.delete(id);
		session.port.close();
		session.queue.length = 0;
		session.network.clear();
		for (const slot of [...this.slots]) {
			if (slot.active?.session !== session) continue;
			slot.worker.terminate();
			this.slots.splice(this.slots.indexOf(slot), 1);
		}
		if (!this.sessions.size) {
			for (const slot of this.slots) slot.worker.terminate();
			this.slots = [];
			this.adaptive = new AdaptiveDownloadConcurrency(this.adaptive.limit, this.adaptive.hardware);
		}
		this.pump();
	}
	snapshot() {
		const active = [...this.sessions.values()].filter(s => s.admitted).length;
		return {
			sessions: this.sessions.size, activeDownloads: active,
			networkReservedBytes: active * LANE_BYTES, processingReservedBytes: active * LANE_BYTES,
			peakNetworkReservedBytes: this.peakLanes * LANE_BYTES, peakProcessingReservedBytes: this.peakLanes * LANE_BYTES,
			cpuTarget: this.adaptive.cpu, networkTarget: 1,
			activeCpu: this.slots.filter(s => s.active).length, activeNetwork: this.networkCount(),
			peakCpu: this.peakCpu, peakNetwork: this.peakNetwork, cpuMs: this.cpuMs, networkMs: this.networkMs, inputBytes: this.inputBytes,
		};
	}
	private send(session: Session, message: SchedulerResponse, transfer: Transferable[] = []): void {
		session.port.postMessage(message, transfer);
	}
	private networkCount(): number { return [...this.sessions.values()].reduce((n, s) => n + s.network.size, 0); }
	private pressure() {
		const queued = [...this.sessions.values()].flatMap(s => s.queue);
		return { cpu: queued.some(q => q.job !== undefined), network: queued.some(q => q.job === undefined) };
	}
	private pump(): void {
		let admitted = [...this.sessions.values()].filter(s => s.admitted).length;
		for (const s of this.sessions.values()) {
			if (s.admitted || s.startId === undefined || (admitted + 1) * LANE_BYTES > DOWNLOAD_BUDGET_BYTES) continue;
			s.admitted = true;
			admitted++;
			this.send(s, { type: 'ready', jobId: s.startId });
		}
		this.peakLanes = Math.max(this.peakLanes, admitted);
		// Separate round robins prevent CPU completions from starving a network waiter.
		for (const stage of ['network', 'cpu'] as const) {
			while (stage === 'network' ? this.networkCount() < 1 : this.slots.filter(slot => slot.active).length < this.adaptive.cpu) {
				const sessions = [...this.sessions.values()];
				const start = sessions.findIndex(s => s.id === this.lastSession[stage]) + 1;
				let dispatched = false;
				for (let i = 0; i < sessions.length; i++) {
					const s = sessions[(start + i) % sessions.length];
					if (!s.admitted || s.stopping) continue;
					const index = s.queue.findIndex(q => (q.job === undefined) === (stage === 'network'));
					if (index < 0) continue;
					const q = s.queue.splice(index, 1)[0];
					this.lastSession[stage] = s.id;
					dispatched = true;
					if (!q.job) {
						s.network.add(q.jobId);
						this.peakNetwork = Math.max(this.peakNetwork, this.networkCount());
						this.send(s, { type: 'ready', jobId: q.jobId });
					} else {
						try {
							const slot = this.slots.find(slot => !slot.active) ?? this.newSlot();
							slot.active = { session: s, jobId: q.jobId, job: q.job, inputBytes: q.job.bytes.length };
							this.peakCpu = Math.max(this.peakCpu, this.slots.filter(slot => slot.active).length);
							slot.worker.postMessage({ jobId: q.jobId, job: q.job }, [q.job.bytes.buffer]);
						} catch (error) { this.fail(s.id, String(error)); }
					}
					break;
				}
				if (!dispatched) break;
			}
		}
		// A lowered setting also retires spare workers after current jobs drain.
		for (const slot of [...this.slots]) {
			if (this.slots.length <= this.adaptive.cpu) break;
			if (!slot.active) { slot.worker.terminate(); this.slots.splice(this.slots.indexOf(slot), 1); }
		}
	}
	private newSlot(): Slot {
		const slot: Slot = { worker: this.makeWorker() };
		this.slots.push(slot);
		slot.worker.onmessage = (event: MessageEvent<{ jobId: number; result?: ProcessingResult; error?: string }>) => {
			const active = slot.active;
			if (!active || active.jobId !== event.data.jobId) return;
			if (!event.data.result) { this.fail(active.session.id, event.data.error ?? 'Processing failed'); return; }
			const result = event.data.result;
			this.cpuMs += result.durationMs;
			this.adaptive.sample('cpu', active.inputBytes, result.durationMs, performance.now(), this.pressure(), active.job.kind, active.job.comparable);
			this.send(active.session, { type: 'result', jobId: active.jobId, result }, [result.bytes.buffer]);
			slot.active = undefined;
			this.pump();
		};
		const failed = () => {
			if (slot.active) this.fail(slot.active.session.id, 'Download processing worker failed');
			else { slot.worker.terminate(); this.slots.splice(this.slots.indexOf(slot), 1); }
		};
		slot.worker.onerror = failed;
		slot.worker.onmessageerror = failed;
		return slot;
	}
}

let scheduler: DownloadScheduler | undefined;
export function getDownloadScheduler(): DownloadScheduler {
	return scheduler ??= new DownloadScheduler(browserDownloadConcurrency.value, navigator.hardwareConcurrency);
}
watch(browserDownloadConcurrency, value => scheduler?.setLimit(value));
