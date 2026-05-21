import type { FileEntry } from 'bgzf';

export interface UploadEntry extends FileEntry {
	readonly name: string;
	readonly parentPath: string;
	readonly size: number;
	readonly type: string;
	readonly lastModified: number;
}

export interface UploadDirectory {
	readonly name: string;
	readonly path: string;
	readonly directories: readonly UploadDirectory[];
	readonly files: readonly UploadEntry[];
}

export interface UploadTreeInit {
	readonly entries: Iterable<FileEntry | UploadEntry>;
	readonly rootName?: string;
}

export interface UploadTreeOptions {
	readonly rootName?: string;
}

type UploadTreeInput =
	| UploadTree
	| UploadTreeInit
	| File
	| readonly File[]
	| FileList
	| DataTransfer
	| DataTransferItemList
	| FileSystemDirectoryHandle;

interface LegacyFileSystemEntry {
	readonly name: string;
	readonly fullPath: string;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
}

interface LegacyFileSystemFileEntry extends LegacyFileSystemEntry {
	file(successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void): void;
}

interface LegacyFileSystemDirectoryEntry extends LegacyFileSystemEntry {
	createReader(): LegacyFileSystemDirectoryReader;
}

interface LegacyFileSystemDirectoryReader {
	readEntries(successCallback: (entries: LegacyFileSystemEntry[]) => void, errorCallback?: (error: DOMException) => void): void;
}

export class UploadTree {
	readonly entries: readonly UploadEntry[];
	readonly root: UploadDirectory;
	readonly rootName: string;
	readonly totalSize: number;
	readonly hasDirectories: boolean;

	private constructor(entries: readonly UploadEntry[], rootName: string) {
		this.entries = Object.freeze([...entries]);
		this.rootName = rootName;
		this.root = UploadTree.buildDirectoryTree(this.entries);
		this.totalSize = this.entries.reduce((sum, entry) => sum + entry.size, 0);
		this.hasDirectories = this.entries.some(entry => entry.path.includes('/'));
	}

	static async from(input: UploadTreeInput, options: UploadTreeOptions = {}): Promise<UploadTree> {
    if (input instanceof UploadTree) {
			return new UploadTree(input.entries, options.rootName ?? input.rootName);
		}
		if (UploadTree.isDirectoryHandle(input)) {
			const entries: FileEntry[] = [];
			for await (const entry of UploadTree.walkDirectoryHandle(input)) entries.push(entry);
			return UploadTree.fromEntries(entries, options.rootName ?? input.name);
		}
		if (UploadTree.isDataTransfer(input)) {
			return UploadTree.from(input.items, options);
		}
		if (UploadTree.isDataTransferItemList(input)) {
			return UploadTree.fromDataTransferItems(input, options);
		}
		if (UploadTree.isFileList(input)) {
			return UploadTree.fromFiles(Array.from(input), options);
		}
		if (input instanceof File) {
			return UploadTree.fromFiles([input], options);
		}
		if (Array.isArray(input)) {
			return UploadTree.fromFiles(input, options);
		}
		if (UploadTree.isUploadTreeInit(input)) {
			return UploadTree.fromEntries(input.entries, input.rootName ?? options.rootName);
		}
		throw new TypeError('Unsupported upload input');
	}

	private static fromFiles(files: readonly File[], options: UploadTreeOptions): UploadTree {
		const entries = files.map((file) => {
			const path = file.webkitRelativePath || file.name;
			return { path, file };
		});
		const rootName = options.rootName ?? UploadTree.inferRootName(entries.map(entry => entry.path));
		return UploadTree.fromEntries(entries, rootName);
	}

	private static async fromDataTransferItems(items: DataTransferItemList, options: UploadTreeOptions): Promise<UploadTree> {
		const entriesPromises: Promise<FileEntry[]>[] = [];
		const fallbackFiles: File[] = [];

		for (const item of items) {
			if (item.kind !== 'file') continue;
			const entry = item.webkitGetAsEntry?.() as LegacyFileSystemEntry | null | undefined;
			if (entry) {
				entriesPromises.push(UploadTree.readEntry(entry));
				continue;
			}
			const file = item.getAsFile();
			if (file) fallbackFiles.push(file);
		}

    const entries = await Promise.all(entriesPromises).then((arr) => arr.flat());

		if (entries.length === 0 && fallbackFiles.length > 0) {
			return UploadTree.fromFiles(fallbackFiles, options);
		}

		const rootName = options.rootName ?? UploadTree.inferRootName(entries.map(entry => entry.path));
		return UploadTree.fromEntries(entries, rootName);
	}

	private static fromEntries(entries: Iterable<FileEntry | UploadEntry>, rootName = ''): UploadTree {
		const normalized = Array.from(entries, UploadTree.normalizeEntry);
		const seen = new Set<string>();
		for (const entry of normalized) {
			if (seen.has(entry.path)) throw new Error(`Duplicate upload path: ${entry.path}`);
			seen.add(entry.path);
		}
		normalized.sort((a, b) => a.path.localeCompare(b.path));
		return new UploadTree(normalized, rootName);
	}

	toFileEntries(): FileEntry[] {
		return this.entries.map(entry => ({ path: entry.path, file: entry.file }));
	}

	private static normalizeEntry(entry: FileEntry | UploadEntry): UploadEntry {
		const path = UploadTree.normalizePath(entry.path);
		const slash = path.lastIndexOf('/');
		const name = slash === -1 ? path : path.slice(slash + 1);
		const parentPath = slash === -1 ? '' : path.slice(0, slash + 1);
		return Object.freeze({
			path,
			file: entry.file,
			name,
			parentPath,
			size: entry.file.size,
			type: entry.file.type,
			lastModified: entry.file.lastModified,
		});
	}

	private static normalizePath(path: string): string {
		const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
		const segments = normalized.split('/');
		if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
			throw new Error(`Invalid upload path: ${path}`);
		}
		return segments.join('/');
	}

	private static buildDirectoryTree(entries: readonly UploadEntry[]): UploadDirectory {
		const root: MutableDirectory = { name: '', path: '', directories: new Map(), files: [] };
		for (const entry of entries) {
			let current = root;
			const parts = entry.parentPath === '' ? [] : entry.parentPath.replace(/\/$/, '').split('/');
			let currentPath = '';
			for (const part of parts) {
				currentPath += `${part}/`;
				let dir = current.directories.get(part);
				if (!dir) {
					dir = { name: part, path: currentPath, directories: new Map(), files: [] };
					current.directories.set(part, dir);
				}
				current = dir;
			}
			current.files.push(entry);
		}
		return UploadTree.freezeDirectory(root);
	}

	private static freezeDirectory(dir: MutableDirectory): UploadDirectory {
		return Object.freeze({
			name: dir.name,
			path: dir.path,
			directories: Object.freeze(Array.from(dir.directories.values(), UploadTree.freezeDirectory)),
			files: Object.freeze([...dir.files]),
		});
	}

	private static async* walkDirectoryHandle(dir: FileSystemDirectoryHandle, prefix = ''): AsyncGenerator<FileEntry> {
		for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
			if (handle.kind === 'file') {
				yield { path: `${prefix}${name}`, file: await (handle as FileSystemFileHandle).getFile() };
			} else {
				yield* UploadTree.walkDirectoryHandle(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
			}
		}
	}

	private static async readEntry(entry: LegacyFileSystemEntry, prefix = ''): Promise<FileEntry[]> {
		if (entry.isFile) {
			const file = await UploadTree.readFileEntry(entry as LegacyFileSystemFileEntry);
			return [{ path: `${prefix}${file.name}`, file }];
		}
		if (!entry.isDirectory) return [];
		const dir = entry as LegacyFileSystemDirectoryEntry;
		const nextPrefix = prefix === '' ? `${entry.name}/` : `${prefix}${entry.name}/`;
		const children = await UploadTree.readAllDirectoryEntries(dir);
		const nested = await Promise.all(children.map(child => UploadTree.readEntry(child, nextPrefix)));
		return nested.flat();
	}

	private static readFileEntry(entry: LegacyFileSystemFileEntry): Promise<File> {
		return new Promise((resolve, reject) => entry.file(resolve, reject));
	}

	private static async readAllDirectoryEntries(entry: LegacyFileSystemDirectoryEntry): Promise<LegacyFileSystemEntry[]> {
		const reader = entry.createReader();
		const entries: LegacyFileSystemEntry[] = [];
		while (true) {
			const batch = await new Promise<LegacyFileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
			if (batch.length === 0) break;
			entries.push(...batch);
		}
		return entries;
	}

	private static inferRootName(paths: readonly string[]): string {
		if (paths.length === 0) return '';
		const first = UploadTree.normalizePath(paths[0]).split('/')[0];
		return paths.every(path => UploadTree.normalizePath(path).split('/')[0] === first) ? first : '';
	}

	private static isDirectoryHandle(input: unknown): input is FileSystemDirectoryHandle {
		return typeof input === 'object' && input !== null && (input as FileSystemDirectoryHandle).kind === 'directory' && 'getFileHandle' in input;
	}

	private static isDataTransfer(input: unknown): input is DataTransfer {
		return typeof DataTransfer !== 'undefined' && input instanceof DataTransfer;
	}

	private static isDataTransferItemList(input: unknown): input is DataTransferItemList {
		return typeof input === 'object' && input !== null && typeof (input as DataTransferItemList).length === 'number' && 'add' in input && 'remove' in input;
	}

	private static isFileList(input: unknown): input is FileList {
		return typeof FileList !== 'undefined' && input instanceof FileList;
	}

	private static isUploadTreeInit(input: unknown): input is UploadTreeInit {
		return typeof input === 'object' && input !== null && 'entries' in input;
	}
}

interface MutableDirectory {
	name: string;
	path: string;
	directories: Map<string, MutableDirectory>;
	files: UploadEntry[];
}
