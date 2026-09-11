import { createTarHeader, parseTarStream } from 'bgzf';
import { AES_CTR_IV_LENGTH, createAesCtrDecryptTransform } from '../../shared/encryption';

/** エントリー全体を Blob にせず、IV を除いた既知サイズで tar を順次生成する。 */
export function createDecryptedTarStream(
	source: ReadableStream<Uint8Array<ArrayBuffer>>,
	key: CryptoKey,
	onEntry: (name: string, completed: number) => void,
	cancelSource: (reason?: unknown) => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
	const entries = (async function* () {
		let completed = 0;
		let currentFile = '';
		try {
			for await (const entry of parseTarStream(source)) {
				currentFile = entry.name;
				onEntry(entry.name, completed);
				if (entry.size < AES_CTR_IV_LENGTH) throw new Error('Encrypted entry is shorter than its IV');
				const size = entry.size - AES_CTR_IV_LENGTH;
				yield createTarHeader(entry.name, size, Date.now());
				const decrypt = createAesCtrDecryptTransform(key);
				const inputDone = entry.stream.pipeTo(decrypt.writable);
				// read と並行して失敗し得るため、即座に rejection handler を付ける。
				void inputDone.catch(() => {});
				const reader = decrypt.readable.getReader();
				let received = 0;
				let finished = false;
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) { finished = true; break; }
						received += value.byteLength;
						yield value;
					}
					await inputDone; // 次の tar ヘッダーへ進む前に入力 reader のロック解除も待つ。
				} finally {
					if (!finished) await reader.cancel().catch(() => {});
					reader.releaseLock();
					await inputDone.catch(() => {});
				}
				if (received !== size) throw new Error(`Decrypted size mismatch: expected ${size}, received ${received}`);
				const padding = (512 - (size % 512)) % 512;
				if (padding) yield new Uint8Array(padding);
				completed++;
				onEntry(entry.name, completed);
			}
			yield new Uint8Array(1024);
		} catch (cause) {
			throw new Error(`Archive input/decryption failed${currentFile ? ` (${currentFile})` : ''}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
		} finally {
			cancelSource();
		}
	})();
	return new ReadableStream<Uint8Array<ArrayBuffer>>({
		async pull(controller) {
			const { done, value } = await entries.next();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		async cancel(reason) {
			// 先に通信を中止し、保留中の read が終わってから iterator を片付ける。
			cancelSource(reason);
			await entries.return(undefined);
		},
	});
}
