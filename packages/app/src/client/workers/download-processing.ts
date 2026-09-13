import { BgzfBlockDecoder, bgzfOutputSize, decompressBgzfBlock } from 'bgzf';
import { decryptAesCtrRange } from '../../shared/encryption';

export const DOWNLOAD_RANGE_BYTES = 32 * 1024 * 1024;
export const PROCESS_JOB_BYTES = 1024 * 1024;
export const PIPELINE_WINDOW = 4;
// Reserve an entire forward-progress lane before starting any network request.
// Each lane covers two CPU stages, their reorder queues, carry and sink buffers.
export const LANE_BYTES = 32 * 1024 * 1024;
export const DOWNLOAD_BUDGET_BYTES = 64 * 1024 * 1024;
export type ProcessingJob = {
	kind: 'decrypt' | 'bgzf';
	bytes: Uint8Array<ArrayBuffer>;
	position: number;
	outputBytes: number;
	key?: CryptoKey;
	iv?: Uint8Array<ArrayBuffer>;
	comparable?: boolean;
};
export type ProcessingResult = { bytes: Uint8Array<ArrayBuffer>; durationMs: number };

export async function processDownloadJob(job: ProcessingJob): Promise<ProcessingResult> {
	if (job.bytes.length > PROCESS_JOB_BYTES || job.outputBytes > PROCESS_JOB_BYTES || job.outputBytes < 0) throw new Error('Processing job exceeds reservation');
	const start = performance.now();
	let bytes: Uint8Array<ArrayBuffer>;
	if (job.kind === 'decrypt') {
		if (!job.key || !job.iv || job.outputBytes !== job.bytes.length) throw new Error('Invalid decryption job');
		bytes = await decryptAesCtrRange(job.key, job.iv, job.bytes, job.position);
	} else {
		bytes = new Uint8Array(job.outputBytes);
		const decoder = new BgzfBlockDecoder();
		let offset = 0;
		for (const block of decoder.push(job.bytes)) {
			const size = bgzfOutputSize(block);
			if (offset + size > bytes.length) throw new Error('BGZF job exceeds output reservation');
			bytes.set(await decompressBgzfBlock(block), offset);
			offset += size;
		}
		decoder.finish();
		if (offset !== bytes.length) throw new Error('BGZF job output size mismatch');
	}
	return { bytes, durationMs: performance.now() - start };
}

export type SchedulerRequest =
	| { type: 'start'; jobId: number }
	| { type: 'network'; jobId: number }
	| { type: 'network-done'; jobId: number; bytes: number; durationMs: number }
	| { type: 'process'; jobId: number; job: ProcessingJob }
	| { type: 'close' };
export type SchedulerResponse =
	| { type: 'ready'; jobId: number }
	| { type: 'result'; jobId: number; result: ProcessingResult }
	| { type: 'fatal'; error: string };
