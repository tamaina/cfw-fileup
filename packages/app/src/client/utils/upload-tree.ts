import type { FileEntry } from 'bgzf';
import { getInvalidPathSegment } from '../../shared/name-validation';
import type { MediaImageConversionSettings, MediaImageOutputMime, MediaVideoConversionSettings, MediaVideoOutputMime } from './media-conversion';

export interface UploadTreeEntryBase {
	readonly path: string;
	readonly name: string;
	readonly parentPath: string;
	readonly size: number;
	readonly type: string;
	readonly lastModified: number;
}

export interface SelectedUploadEntry extends UploadTreeEntryBase {
	readonly file: File;
}

export type UploadEntry = SelectedUploadEntry;

/** HLS 変換するエントリごとのカスタム設定（tar/m3u8 へ埋め込まれる） */
export interface HlsEntryUploadSettings {
	readonly title?: string;
	/** リサイズ済みポスター画像（poster.jpg として tar に追加される） */
	readonly poster?: File;
}

export type UploadConversionPlan =
	| {
		readonly kind: 'image';
		readonly outputPath: string;
		readonly outputType: MediaImageOutputMime;
		readonly settings: MediaImageConversionSettings;
	}
	| {
		readonly kind: 'video';
		readonly outputPath: string;
		readonly outputType: MediaVideoOutputMime;
		readonly settings: MediaVideoConversionSettings;
		readonly hls?: HlsEntryUploadSettings;
	};

export interface PlannedUploadEntry extends UploadTreeEntryBase {
	readonly originalIndex: number;
	readonly originalPath: string;
	readonly sourceEntry: SelectedUploadEntry;
	readonly conversionPlan?: UploadConversionPlan;
}

export interface ResolvedUploadEntry extends UploadTreeEntryBase {
	readonly originalIndex: number;
	readonly source:
		| { readonly kind: 'file'; readonly file: File }
		| { readonly kind: 'opfs'; readonly opfsName: string };
}

export interface UploadDirectory<TEntry extends UploadTreeEntryBase = SelectedUploadEntry> {
	readonly name: string;
	readonly path: string;
	readonly directories: readonly UploadDirectory<TEntry>[];
	readonly files: readonly TEntry[];
}

export interface UploadTreeInit<TEntry extends FileEntry | UploadTreeEntryBase = FileEntry | SelectedUploadEntry> {
	readonly entries: Iterable<TEntry>;
	readonly rootName?: string;
}

export interface UploadTreeOptions {
	readonly rootName?: string;
}

type UploadTreeInput =
	| UploadTree<SelectedUploadEntry>
	| UploadTreeInit<FileEntry | SelectedUploadEntry>
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

export class UploadTree<TEntry extends UploadTreeEntryBase = SelectedUploadEntry> {
	readonly entries: readonly TEntry[];
	readonly root: UploadDirectory<TEntry>;
	readonly rootName: string;
	readonly totalSize: number;
	readonly hasDirectories: boolean;

	private constructor(entries: readonly TEntry[], rootName: string) {
		this.entries = Object.freeze([...entries]);
		this.rootName = rootName;
		this.root = UploadTree.buildDirectoryTree(this.entries);
		this.totalSize = this.entries.reduce((sum, entry) => sum + entry.size, 0);
		this.hasDirectories = this.entries.some(entry => entry.path.includes('/'));
	}

	static async from(input: UploadTreeInput, options: UploadTreeOptions = {}): Promise<UploadTree<SelectedUploadEntry>> {
		if (input instanceof UploadTree) {
			return UploadTree.fromEntries(input.entries, { rootName: options.rootName ?? input.rootName });
		}
		if (UploadTree.isDirectoryHandle(input)) {
			const entries: FileEntry[] = [];
			for await (const entry of UploadTree.walkDirectoryHandle(input)) entries.push(entry);
			return UploadTree.fromEntries(entries, { rootName: options.rootName ?? input.name });
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
			return UploadTree.fromEntries(input.entries, { rootName: input.rootName ?? options.rootName });
		}
		throw new TypeError('Unsupported upload input');
	}

	static fromFiles(files: readonly File[], options: UploadTreeOptions = {}): UploadTree<SelectedUploadEntry> {
		const entries = files.map((file) => {
			const path = file.webkitRelativePath || file.name;
			return { path, file };
		});
		const rootName = options.rootName ?? UploadTree.inferRootName(entries.map(entry => entry.path));
		return UploadTree.fromEntries(entries, { rootName });
	}

	static fromEntries<TInput extends FileEntry | UploadTreeEntryBase>(
		entries: Iterable<TInput>,
		options: UploadTreeOptions = {},
	): UploadTree<NormalizeUploadTreeEntry<TInput>> {
		const normalized = Array.from(entries, entry => UploadTree.normalizeEntry(entry) as NormalizeUploadTreeEntry<TInput>);
		const seen = new Set<string>();
		for (const entry of normalized) {
			if (seen.has(entry.path)) throw new Error(`Duplicate upload path: ${entry.path}`);
			seen.add(entry.path);
		}
		normalized.sort((a, b) => a.path.localeCompare(b.path));
		return new UploadTree(normalized, options.rootName ?? '');
	}

	mapEntries<TNext extends UploadTreeEntryBase>(
		mapper: (entry: TEntry, index: number) => TNext,
		options: UploadTreeOptions = {},
	): UploadTree<TNext> {
		return UploadTree.fromEntries(this.entries.map(mapper), { rootName: options.rootName ?? this.rootName }) as UploadTree<TNext>;
	}

	toFileEntries(this: UploadTree<SelectedUploadEntry>): FileEntry[] {
		return this.entries.map(entry => ({ path: entry.path, file: entry.file }));
	}

	private static async fromDataTransferItems(items: DataTransferItemList, options: UploadTreeOptions): Promise<UploadTree<SelectedUploadEntry>> {
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
		return UploadTree.fromEntries(entries, { rootName });
	}

	private static normalizeEntry<TInput extends FileEntry | UploadTreeEntryBase>(entry: TInput): NormalizeUploadTreeEntry<TInput> {
		const path = UploadTree.normalizePath(entry.path);
		const slash = path.lastIndexOf('/');
		const name = slash === -1 ? path : path.slice(slash + 1);
		const parentPath = slash === -1 ? '' : path.slice(0, slash + 1);
		const file = UploadTree.hasFile(entry) ? entry.file : undefined;
		return Object.freeze({
			...entry,
			path,
			name,
			parentPath,
			size: UploadTree.hasUploadTreeMetadata(entry) ? entry.size : file?.size ?? 0,
			type: UploadTree.hasUploadTreeMetadata(entry) ? entry.type : file?.type ?? '',
			lastModified: UploadTree.hasUploadTreeMetadata(entry) ? entry.lastModified : file?.lastModified ?? Date.now(),
		}) as unknown as NormalizeUploadTreeEntry<TInput>;
	}

	private static normalizePath(path: string): string {
		const invalidSegment = getInvalidPathSegment(path, { allowTrailingSlash: false });
		if (invalidSegment !== null) throw new Error(`Invalid upload path: ${path}`);
		const normalized = path.replace(/^\/+/, '');
		const segments = normalized.split('/');
		if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
			throw new Error(`Invalid upload path: ${path}`);
		}
		return segments.join('/');
	}

	private static buildDirectoryTree<TEntry extends UploadTreeEntryBase>(entries: readonly TEntry[]): UploadDirectory<TEntry> {
		const root: MutableDirectory<TEntry> = { name: '', path: '', directories: new Map(), files: [] };
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

	private static freezeDirectory<TEntry extends UploadTreeEntryBase>(dir: MutableDirectory<TEntry>): UploadDirectory<TEntry> {
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

	private static isUploadTreeInit(input: unknown): input is UploadTreeInit<FileEntry | SelectedUploadEntry> {
		return typeof input === 'object' && input !== null && 'entries' in input;
	}

	private static hasFile(entry: FileEntry | UploadTreeEntryBase): entry is FileEntry {
		return 'file' in entry && entry.file instanceof File;
	}

	private static hasUploadTreeMetadata(entry: FileEntry | UploadTreeEntryBase): entry is UploadTreeEntryBase {
		return 'size' in entry && 'type' in entry && 'lastModified' in entry;
	}
}

type NormalizeUploadTreeEntry<TInput extends FileEntry | UploadTreeEntryBase> =
	TInput extends UploadTreeEntryBase
		? TInput
		: SelectedUploadEntry;

interface MutableDirectory<TEntry extends UploadTreeEntryBase> {
	name: string;
	path: string;
	directories: Map<string, MutableDirectory<TEntry>>;
	files: TEntry[];
}
