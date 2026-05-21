const TEMP_FILE_PREFIX = 'cfw-fileup-';

let startupCleanupPromise: Promise<void> | null = null;

export type OpfsTempFileResult = {
	readonly opfsName: string;
	readonly filename: string;
	readonly mimeType: string;
};

export async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
	if (!('storage' in navigator) || !navigator.storage.getDirectory) {
		throw new Error('OPFS is not supported in this browser');
	}
	return await navigator.storage.getDirectory();
}

export async function cleanupStaleOpfsTempFiles(root: FileSystemDirectoryHandle): Promise<void> {
	startupCleanupPromise ??= (async () => {
		for await (const [name] of root as unknown as AsyncIterable<[string, FileSystemHandle]>) {
			if (!name.startsWith(TEMP_FILE_PREFIX)) continue;
			await root.removeEntry(name).catch(() => {});
		}
	})();
	await startupCleanupPromise;
}

export async function createOpfsTempFile(id: string, extension: string): Promise<{
	readonly opfsName: string;
	readonly fileHandle: FileSystemFileHandle;
}> {
	const root = await getOpfsRoot();
	await cleanupStaleOpfsTempFiles(root);
	const opfsName = `${TEMP_FILE_PREFIX}${id}-${Date.now()}${extension}`;
	const fileHandle = await root.getFileHandle(opfsName, { create: true });
	return { opfsName, fileHandle };
}

export async function removeOpfsTempFile(opfsName: string): Promise<void> {
	const root = await getOpfsRoot();
	await root.removeEntry(opfsName).catch(() => {});
}

export async function getOpfsTempFile(opfsName: string): Promise<File> {
	const root = await getOpfsRoot();
	const fileHandle = await root.getFileHandle(opfsName);
	return await fileHandle.getFile();
}
