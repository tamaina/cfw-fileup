import { isValidFilePath } from '../../shared/name-validation';

export interface UploadPathEntry {
	readonly path: string;
}

export interface UploadPathTransformResult<TEntry extends UploadPathEntry> {
	readonly entries: TEntry[];
	readonly trimmedRootName: string | null;
}

export interface UploadConflictTarget {
	readonly path: string;
	readonly parentPath: string;
	readonly fileName: string;
}

export interface UploadConflictDirectoryPlan {
	readonly parentPath: string;
	readonly targets: readonly UploadConflictTarget[];
}

export interface UploadConflictDirectoryEntry {
	readonly type: 'dir' | 'file';
	readonly name: string;
}

export function getEffectiveUploadEntries<TEntry extends UploadPathEntry>(entries: readonly TEntry[], shouldTrimSingleRoot: boolean): UploadPathTransformResult<TEntry> {
	const rootName = shouldTrimSingleRoot ? getSingleRootDirectoryName(entries) : null;
	if (!rootName) return { entries: [...entries], trimmedRootName: null };

	const transformed = entries.map(entry => ({
		...entry,
		path: entry.path.slice(rootName.length + 1),
	})) as TEntry[];
	validateUploadEntryPaths(transformed);
	return { entries: transformed, trimmedRootName: rootName };
}

export function getSingleRootDirectoryName(entries: readonly Pick<UploadPathEntry, 'path'>[]): string | null {
	if (entries.length === 0) return null;
	let rootName: string | null = null;
	for (const entry of entries) {
		const slash = entry.path.indexOf('/');
		if (slash <= 0) return null;
		const currentRootName = entry.path.slice(0, slash);
		if (rootName == null) {
			rootName = currentRootName;
		} else if (rootName !== currentRootName) {
			return null;
		}
		if (entry.path.length === slash + 1) return null;
	}
	return rootName;
}

export function buildUploadConflictDirectoryPlan(paths: readonly string[]): UploadConflictDirectoryPlan[] {
	const grouped = new Map<string, UploadConflictTarget[]>();
	for (const path of paths) {
		const lastSlash = path.lastIndexOf('/');
		const parentPath = lastSlash === -1 ? '' : path.slice(0, lastSlash + 1);
		const fileName = path.slice(lastSlash + 1);
		const targets = grouped.get(parentPath);
		const target = { path, parentPath, fileName };
		if (targets) {
			targets.push(target);
		} else {
			grouped.set(parentPath, [target]);
		}
	}

	return Array.from(grouped.entries(), ([parentPath, targets]) => ({ parentPath, targets }))
		.sort((a, b) => a.parentPath.localeCompare(b.parentPath));
}

export function isPathUnderMissingDirectory(path: string, missingDirectories: ReadonlySet<string>): boolean {
	for (const directory of missingDirectories) {
		if (directory !== '' && path.startsWith(directory)) return true;
	}
	return false;
}

export function findUploadConflictsInDirectory(targets: readonly UploadConflictTarget[], entries: readonly UploadConflictDirectoryEntry[]): string[] {
	const existingFileNames = new Set(entries.filter(entry => entry.type === 'file').map(entry => entry.name));
	return targets.filter(target => existingFileNames.has(target.fileName)).map(target => target.path);
}

function validateUploadEntryPaths(entries: readonly Pick<UploadPathEntry, 'path'>[]): void {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!isValidFilePath(entry.path)) throw new Error(`Invalid upload path: ${entry.path}`);
		if (seen.has(entry.path)) throw new Error(`Duplicate upload path: ${entry.path}`);
		seen.add(entry.path);
	}
}
