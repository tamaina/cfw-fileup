import { TarArchiver, type ArchiveProgress, type FileEntry, type TarIndex } from 'bgzf';

export interface TarArchiveResult {
	stream: ReadableStream<Uint8Array<ArrayBuffer>>;
	index: Promise<TarIndex[]>;
}

export interface WrittenTarArchiveResult {
	file: File;
	index: TarIndex[];
}

export async function createTarArchive(
	entries: Iterable<FileEntry> | AsyncIterable<FileEntry>,
	onProgress?: (progress: ArchiveProgress) => void,
): Promise<TarArchiveResult> {
	const archiver = await TarArchiver.createFromEntries(entries, onProgress);
	return {
		stream: archiver.stream,
		index: archiver.index,
	};
}

export async function writeTarArchiveToDirectory(
	entries: Iterable<FileEntry> | AsyncIterable<FileEntry>,
	directory: FileSystemDirectoryHandle,
	name: string,
	onProgress?: (progress: ArchiveProgress) => void,
): Promise<WrittenTarArchiveResult> {
	const archive = await createTarArchive(entries, onProgress);
	const handle = await directory.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	const [, index] = await Promise.all([
		writeStreamToWritable(archive.stream, writable),
		archive.index,
	]);
	return {
		file: await handle.getFile(),
		index,
	};
}

async function writeStreamToWritable(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	writable: FileSystemWritableFileStream,
): Promise<void> {
	const reader = stream.getReader();
	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await writable.write(value);
		}
		await writable.close();
	} catch (error) {
		await writable.abort().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}
