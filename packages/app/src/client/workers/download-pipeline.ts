import { BgzfBlockDecoder, bgzfOutputSize } from 'bgzf';
import { PIPELINE_WINDOW, PROCESS_JOB_BYTES, type ProcessingJob, type ProcessingResult, type SchedulerRequest, type SchedulerResponse } from './download-processing';

/** Per-download port, shared across all stages, with a single cancellation boundary. */
export class DownloadPipeline {
	readonly abort = new AbortController();
	private nextId = 0;
	private pending = new Map<number, { resolve: (value?: ProcessingResult) => void; reject: (error: unknown) => void }>();
	private closed = false;
	private cleanups: Promise<void>[] = [];
	private closing: Promise<void> | undefined;
	trackCleanup(cleanup: Promise<void>): void { this.cleanups.push(cleanup); }
	async finish(): Promise<void> { this.close(); await this.closing; await Promise.all(this.cleanups); }
	constructor(private port: MessagePort) {
		port.onmessage = (event: MessageEvent<SchedulerResponse>) => {
			const message = event.data;
			if (message.type === 'fatal') { this.close(new Error(message.error)); return; }
			const pending = this.pending.get(message.jobId);
			this.pending.delete(message.jobId);
			pending?.resolve(message.type === 'result' ? message.result : undefined);
		};
		port.onmessageerror = () => this.close(new Error('Download pipeline message failed'));
	}
	private request(message: SchedulerRequest & { jobId: number }, transfer: Transferable[] = []): Promise<ProcessingResult | undefined> {
		if (this.closed) return Promise.reject(this.abort.signal.reason);
		return new Promise((resolve, reject) => {
			this.pending.set(message.jobId, { resolve, reject });
			try { this.port.postMessage(message, transfer); } catch (error) { this.pending.delete(message.jobId); reject(error); }
		});
	}
	async start(): Promise<void> { await this.request({ type: 'start', jobId: ++this.nextId }); }
	async network(): Promise<(bytes: number, durationMs: number) => void> {
		const jobId = ++this.nextId;
		await this.request({ type: 'network', jobId });
		return (bytes, durationMs) => {
			if (!this.closed) this.port.postMessage({ type: 'network-done', jobId, bytes, durationMs } satisfies SchedulerRequest);
		};
	}
	async process(job: ProcessingJob): Promise<Uint8Array<ArrayBuffer>> {
		const result = await this.request({ type: 'process', jobId: ++this.nextId, job }, [job.bytes.buffer]);
		if (!result) throw new Error('Missing processing result');
		return result.bytes;
	}
	close(reason: unknown = new DOMException('Download finished', 'AbortError')): void {
		if (this.closed) return;
		this.closed = true;
		this.abort.abort(reason);
		for (const pending of this.pending.values()) pending.reject(reason);
		this.pending.clear();
		this.closing = Promise.allSettled(this.cleanups).then(() => {
			this.port.postMessage({ type: 'close' } satisfies SchedulerRequest);
			this.port.close();
		});
	}
}

function fromGenerator(iterator: AsyncGenerator<Uint8Array<ArrayBuffer>>, pipeline: DownloadPipeline): ReadableStream<Uint8Array<ArrayBuffer>> {
	return new ReadableStream({
		async pull(controller) {
			try {
				const result = await iterator.next();
				if (result.done) controller.close(); else controller.enqueue(result.value);
			} catch (error) { pipeline.close(error); controller.error(error); }
		},
		async cancel(reason) { pipeline.close(reason); await iterator.return(undefined); },
	}, { highWaterMark: 0 });
}

async function* orderedJobs(jobs: AsyncGenerator<ProcessingJob>, pipeline: DownloadPipeline): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	const pending: Promise<Uint8Array<ArrayBuffer>>[] = [];
	let ended = false;
	try {
		while (true) {
			while (!ended && pending.length < PIPELINE_WINDOW) {
				const next = await jobs.next();
				if (next.done) { ended = true; break; }
				const result = pipeline.process(next.value);
				void result.catch(() => {});
				pending.push(result);
			}
			if (!pending.length) break;
			// Refill only after downstream pulls again: the yielded buffer occupies a slot.
			const value = await pending[0];
			if (value.length) yield value;
			pending.shift();
		}
	} finally { await jobs.return(undefined); }
}

async function* sourceChunks(source: ReadableStream<Uint8Array<ArrayBuffer>>, signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	const reader = source.getReader();
	const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
	signal.addEventListener('abort', abort, { once: true });
	let ended = false;
	try {
		while (true) {
			signal.throwIfAborted();
			const result = await reader.read();
			signal.throwIfAborted();
			if (result.done) { ended = true; return; }
			yield result.value;
		}
	} finally {
		signal.removeEventListener('abort', abort);
		if (!ended) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function parallelDecrypt(source: ReadableStream<Uint8Array<ArrayBuffer>>, key: CryptoKey, pipeline: DownloadPipeline, comparable = false): ReadableStream<Uint8Array<ArrayBuffer>> {
	async function* jobs(): AsyncGenerator<ProcessingJob> {
		const iv = new Uint8Array(16);
		let ivLength = 0;
		let position = 0;
		let input = new Uint8Array(PROCESS_JOB_BYTES);
		let length = 0;
		for await (const chunk of sourceChunks(source, pipeline.abort.signal)) {
			let offset = 0;
			if (ivLength < 16) {
				const take = Math.min(16 - ivLength, chunk.length);
				iv.set(chunk.subarray(0, take), ivLength);
				ivLength += take;
				offset = take;
			}
			while (offset < chunk.length) {
				const take = Math.min(input.length - length, chunk.length - offset);
				input.set(chunk.subarray(offset, offset + take), length);
				length += take;
				offset += take;
				if (length === input.length) {
					yield { kind: 'decrypt', bytes: input, outputBytes: length, key, iv, position, comparable };
					position += length;
					input = new Uint8Array(PROCESS_JOB_BYTES);
					length = 0;
				}
			}
		}
		if (ivLength !== 16) throw new Error('Encrypted data is shorter than its IV');
		if (length) yield { kind: 'decrypt', bytes: input.subarray(0, length), outputBytes: length, key, iv, position, comparable };
	}

	return fromGenerator(orderedJobs(jobs(), pipeline), pipeline);
}

export function parallelBgzf(source: ReadableStream<Uint8Array<ArrayBuffer>>, pipeline: DownloadPipeline, comparable = false): ReadableStream<Uint8Array<ArrayBuffer>> {
	async function* jobs(): AsyncGenerator<ProcessingJob> {
		const decoder = new BgzfBlockDecoder();
		let bytes = new Uint8Array(PROCESS_JOB_BYTES);
		let length = 0;
		let outputBytes = 0;
		let position = 0;
		for await (const chunk of sourceChunks(source, pipeline.abort.signal)) {
			for (const block of decoder.push(chunk)) {
				const size = bgzfOutputSize(block);
				if (length && (length + block.length > PROCESS_JOB_BYTES || outputBytes + size > PROCESS_JOB_BYTES)) {
					yield { kind: 'bgzf', bytes: bytes.subarray(0, length), outputBytes, position, comparable };
					position += length;
					bytes = new Uint8Array(PROCESS_JOB_BYTES);
					length = 0;
					outputBytes = 0;
				}
				bytes.set(block, length);
				length += block.length;
				outputBytes += size;
			}
		}
		decoder.finish();
		if (length) yield { kind: 'bgzf', bytes: bytes.subarray(0, length), outputBytes, position, comparable };
	}

	return fromGenerator(orderedJobs(jobs(), pipeline), pipeline);
}
