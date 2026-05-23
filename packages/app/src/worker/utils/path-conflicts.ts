import { and, eq, like, or } from 'drizzle-orm';
import type { getDb } from './db';
import { directories, files } from '../scheme/index';

type Db = ReturnType<typeof getDb>;

function parentFilePaths(path: string): string[] {
	const segments = path.replace(/\/$/, '').split('/');
	const parents: string[] = [];
	for (let i = 1; i < segments.length; i++) {
		parents.push(segments.slice(0, i).join('/'));
	}
	return parents;
}

export function findArchiveEntryPathConflict(paths: readonly string[]): string | null {
	const seenFiles = new Set<string>();
	const seenDirectoryPrefixes = new Set<string>();

	for (const path of paths) {
		if (seenFiles.has(path) || seenDirectoryPrefixes.has(path)) return path;

		const segments = path.split('/');
		let prefix = '';
		for (let i = 0; i < segments.length - 1; i++) {
			prefix = prefix === '' ? segments[i] : `${prefix}/${segments[i]}`;
			if (seenFiles.has(prefix)) return path;
			seenDirectoryPrefixes.add(prefix);
		}

		seenFiles.add(path);
	}

	return null;
}

export async function hasFileDirectoryConflictForFile(db: Db, bucketId: string, path: string): Promise<boolean> {
	const directoryPath = `${path}/`;
	const directoryConflict = await db
		.select({ id: directories.id })
		.from(directories)
		.where(and(eq(directories.bucketId, bucketId), like(directories.path, `${directoryPath}%`)))
		.get();
	if (directoryConflict) return true;

	const parents = parentFilePaths(path);
	if (parents.length === 0) return false;
	const parentConflict = await db
		.select({ id: files.id })
		.from(files)
		.where(and(
			eq(files.bucketId, bucketId),
			or(...parents.map(parent => eq(files.path, parent))),
		))
		.get();
	return parentConflict !== undefined;
}

export async function hasFileDirectoryConflictForDirectory(db: Db, bucketId: string, path: string): Promise<boolean> {
	const normalizedPath = path.endsWith('/') ? path : `${path}/`;
	const filePath = normalizedPath.replace(/\/$/, '');
	const conflictPaths = [filePath, ...parentFilePaths(normalizedPath)];
	const fileConflict = await db
		.select({ id: files.id })
		.from(files)
		.where(and(
			eq(files.bucketId, bucketId),
			or(...conflictPaths.map(conflictPath => eq(files.path, conflictPath))),
		))
		.get();
	return fileConflict !== undefined;
}
