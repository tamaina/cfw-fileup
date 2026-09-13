/** Range staging is private to a download, never a reusable cache of decrypted data. */
export interface StoredRange {
	readonly size: number;
	read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
	dispose(): Promise<void>;
}
export interface RangeSink {
	write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
	finish(): Promise<StoredRange>;
	abort(): Promise<void>;
}
export interface RangeCache {
	readonly disk: boolean;
	create(size: number): Promise<RangeSink>;
	close(): Promise<void>;
}

export const RANGE_CACHE_DIRECTORY = 'download-range-cache-v1';
const lockName = (name: string) => `${RANGE_CACHE_DIRECTORY}:${name}`;

function memoryCache(): RangeCache {
	return {
		disk: false,
		async create(size) {
			let bytes = new Uint8Array(size);
			let position = 0;
			return {
				async write(chunk) { bytes.set(chunk, position); position += chunk.length; },
				async finish() {
					return { size, async read(offset, length) { return bytes.slice(offset, offset + length); }, async dispose() { bytes = new Uint8Array(0); } };
				},
				async abort() { bytes = new Uint8Array(0); },
			};
		},
		async close() {},
	};
}

/** Web Locks prevent cleanup from deleting ranges owned by another worker/tab. */
export async function createRangeCache(preferDisk: boolean): Promise<RangeCache> {
	if (!preferDisk || typeof navigator === 'undefined' || !navigator.storage?.getDirectory || !navigator.locks) return memoryCache();
	let root: FileSystemDirectoryHandle;
	try {
		root = await (await navigator.storage.getDirectory()).getDirectoryHandle(RANGE_CACHE_DIRECTORY, { create: true });
	} catch (error) {
		if (error instanceof DOMException && ['SecurityError', 'NotSupportedError', 'InvalidStateError'].includes(error.name)) return memoryCache();
		throw error;
	}
	// A terminated worker releases its lock automatically. Only orphan sessions are removed.
	for await (const [name] of root as unknown as AsyncIterable<[string, FileSystemHandle]>) {
		if (!/^[a-f0-9-]{36}$/.test(name)) continue;
		await navigator.locks.request(lockName(name), { ifAvailable: true }, async lock => {
			if (lock) await root.removeEntry(name, { recursive: true }).catch(() => {});
		});
	}
	const name = crypto.randomUUID();
	let release!: () => void;
	const lifetime = new Promise<void>(resolve => { release = resolve; });
	let ready!: (directory: FileSystemDirectoryHandle) => void;
	let failed!: (error: unknown) => void;
	const acquired = new Promise<FileSystemDirectoryHandle>((resolve, reject) => { ready = resolve; failed = reject; });
	const lockDone = navigator.locks.request(lockName(name), async () => {
		try { ready(await root.getDirectoryHandle(name, { create: true })); await lifetime; } catch (error) { failed(error); }
	});
	void lockDone.catch(failed);
	let directory: FileSystemDirectoryHandle;
	try { directory = await acquired; } catch (error) { release(); await lockDone.catch(() => {}); throw error; }
	let closed = false;
	return {
		disk: true,
		async create(size) {
			if (closed) throw new Error('Range cache is closed');
			const fileName = crypto.randomUUID();
			const handle = await directory.getFileHandle(fileName, { create: true });
			let writer: FileSystemWritableFileStream;
			try { writer = await handle.createWritable(); } catch (error) { await directory.removeEntry(fileName).catch(() => {}); throw error; }
			let finished = false;
			return {
				async write(bytes) { await writer.write(bytes); },
				async finish() {
					await writer.close();
					finished = true;
					const file = await handle.getFile();
					if (file.size !== size) throw new Error('Staged range size mismatch');
					let deletion: Promise<void> | undefined;
					return {
						size,
						async read(offset, length) { return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()); },
						dispose() { return deletion ??= directory.removeEntry(fileName); },
					};
				},
				async abort() {
					if (!finished) await writer.abort().catch(() => {});
					await directory.removeEntry(fileName).catch(() => {});
				},
			};
		},
		async close() {
			if (closed) return;
			closed = true;
			try { await root.removeEntry(name, { recursive: true }); } finally { release(); await lockDone; }
		},
	};
}
