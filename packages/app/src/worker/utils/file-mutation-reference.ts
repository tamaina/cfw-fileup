import { inArray } from 'drizzle-orm';
import { tarFiles, targzFiles } from '../scheme/index';
import { getDb } from './db';
import type { FileReference } from '../events/file-mutations';

type ArchiveFile = {
	id: string;
	path: string;
	isTar: boolean;
	isTargz: boolean;
};

function addEntryPath(map: Map<string, string[]>, fileId: string, path: string): void {
	const paths = map.get(fileId);
	if (paths === undefined) {
		map.set(fileId, [path]);
		return;
	}
	paths.push(path);
}

export async function toFileMutationReferences(db: ReturnType<typeof getDb>, files: ArchiveFile[]): Promise<FileReference[]> {
	if (files.length === 0) return [];

	const tarFileIds = files.filter(file => file.isTar).map(file => file.id);
	const targzFileIds = files.filter(file => file.isTargz).map(file => file.id);
	const entryPathsByFileId = new Map<string, string[]>();

	if (tarFileIds.length > 0) {
		const entries = await db
			.select({ fileId: tarFiles.fileId, path: tarFiles.path })
			.from(tarFiles)
			.where(inArray(tarFiles.fileId, tarFileIds));
		for (const entry of entries) addEntryPath(entryPathsByFileId, entry.fileId, entry.path);
	}

	if (targzFileIds.length > 0) {
		const entries = await db
			.select({ fileId: targzFiles.fileId, path: targzFiles.path })
			.from(targzFiles)
			.where(inArray(targzFiles.fileId, targzFileIds));
		for (const entry of entries) addEntryPath(entryPathsByFileId, entry.fileId, entry.path);
	}

	return files.map(file => ({
		id: file.id,
		path: file.path,
		entryPaths: entryPathsByFileId.get(file.id),
	}));
}

export async function toFileMutationReference(db: ReturnType<typeof getDb>, file: ArchiveFile): Promise<FileReference> {
	const reference = (await toFileMutationReferences(db, [file])).at(0);
	if (!reference) throw new Error('Failed to create file mutation reference');
	return reference;
}
