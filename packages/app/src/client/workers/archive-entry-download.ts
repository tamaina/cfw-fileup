import { isBgzf } from 'bgzf';
import { importAesCtrKey, multibaseToKey } from '../../shared/encryption';
import { createRangedDownloadStream, type RangedDownloadOptions } from './download-resilience';
import { DownloadPipeline, parallelBgzf, parallelDecrypt } from './download-pipeline';

export type ArchiveEntrySpan =
	| { type: 'tar'; path: string; offset: number; size: number }
	| { type: 'targz'; path: string; aStart: number; aEnd: number; rStartOffset: number; rEndOffset: number };

/** Indexed extraction only; CTR starts at the entry's IV, after trimming tar bytes. */
export async function createArchiveEntryDownloadStream(url: string, init: RequestInit, entry: ArchiveEntrySpan, pipeline: DownloadPipeline, options: RangedDownloadOptions, encryptionKey?: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
	if (entry.type === 'targz') validateTrim(entry.rStartOffset, entry.rEndOffset);
	let cryptoKey: CryptoKey | undefined;
	if (encryptionKey) {
		const rawKey = multibaseToKey(encryptionKey);
		if (!rawKey) throw new Error('Invalid encryption key');
		cryptoKey = await importAesCtrKey(rawKey, ['decrypt']);
	}
	const start = entry.type === 'tar' ? entry.offset : entry.aStart;
	const end = entry.type === 'tar' ? entry.offset + entry.size : entry.aEnd;
	const firstUrl = new URL(url, location.origin);
	firstUrl.searchParams.set('entry', entry.path);
	let stream = createRangedDownloadStream(url, init, {
		...options, start, end, demandDriven: true, maxBufferedRanges: 1, firstRangeUrl: firstUrl.href,
	});
	if (entry.type === 'targz') {
		stream = parallelBgzf(requireBgzf(stream), pipeline);
		stream = trimEntryStream(stream, entry.rStartOffset, entry.rEndOffset);
	}
	if (cryptoKey) stream = parallelDecrypt(stream, cryptoKey, pipeline);
	return stream;
}

function requireBgzf(source: ReadableStream<Uint8Array<ArrayBuffer>>): ReadableStream<Uint8Array<ArrayBuffer>> {
	let first = true;
	return source.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
		transform(chunk, controller) {
			if (first && !isBgzf(chunk)) throw new Error('Indexed streaming requires BGZF; ordinary gzip entries are unsupported');
			first = false;
			controller.enqueue(chunk);
		},
	}, { highWaterMark: 1 }, { highWaterMark: 0 }));
}

/** Retain only a final BGZF block's trailing bytes, never the complete entry. */
function validateTrim(prefix: number, suffix: number): void {
	if (![prefix, suffix].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 65536)) throw new RangeError('Invalid BGZF entry trim');
}

export function trimEntryStream(source: ReadableStream<Uint8Array<ArrayBuffer>>, prefix: number, suffix: number): ReadableStream<Uint8Array<ArrayBuffer>> {
	validateTrim(prefix, suffix);
	let skip = prefix;
	let tail = new Uint8Array(0);
	return source.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
		transform(chunk, controller) {
			const drop = Math.min(skip, chunk.length);
			skip -= drop;
			const bytes = chunk.subarray(drop);
			const emit = Math.max(0, tail.length + bytes.length - suffix);
			const fromTail = Math.min(emit, tail.length);
			if (fromTail) controller.enqueue(tail.slice(0, fromTail));
			const fromChunk = emit - fromTail;
			if (fromChunk) controller.enqueue(bytes.slice(0, fromChunk));
			const rest = tail.subarray(fromTail);
			const next = new Uint8Array(rest.length + bytes.length - fromChunk);
			next.set(rest); next.set(bytes.subarray(fromChunk), rest.length);
			tail = next;
		},
		flush() {
			if (skip || tail.length !== suffix) throw new Error('Truncated BGZF entry span');
		},
	}, { highWaterMark: 1 }, { highWaterMark: 0 }));
}
