import { convertImageFile, convertVideoFile } from '@/utils/media-conversion';
import type { UploadImageCompressionOptions, UploadResolvedEntry, UploadVideoConversionOptions, UploadWorkerFileEntry } from './upload-worker-types';

export interface MediaConversionWorkerFileEntry extends UploadWorkerFileEntry {
	index: number;
	conversionKind: 'image' | 'video';
	originalPath: string;
}

export interface MediaConversionWorkerRequest {
	id: string;
	files: MediaConversionWorkerFileEntry[];
	imageCompression?: UploadImageCompressionOptions;
	videoConversion?: UploadVideoConversionOptions;
}

export interface MediaConversionProgress {
	fileIndex: number;
	totalFiles: number;
	fileName: string;
	phase: 'converting' | 'writing';
	videoProgress?: number;
}

export type MediaConversionWorkerMessage =
	| { type: 'progress'; id: string; progress: MediaConversionProgress }
	| { type: 'converted-entry'; id: string; entry: UploadResolvedEntry }
	| { type: 'fallback-entry'; id: string; entry: UploadResolvedEntry; error: string }
	| { type: 'done'; id: string }
	| { type: 'error'; id: string; error: string };

self.onmessage = (event: MessageEvent<MediaConversionWorkerRequest>) => {
	void handleRequest(event.data);
};

async function handleRequest(request: MediaConversionWorkerRequest): Promise<void> {
	try {
		for (let i = 0; i < request.files.length; i++) {
			const entry = request.files[i];
			post({
				type: 'progress',
				id: request.id,
				progress: { fileIndex: i, totalFiles: request.files.length, fileName: entry.path, phase: 'converting' },
			});
			const file = await convertEntryFile(entry, request, progress => {
				post({
					type: 'progress',
					id: request.id,
					progress: {
						fileIndex: i,
						totalFiles: request.files.length,
						fileName: entry.path,
						phase: 'converting',
						videoProgress: progress,
					},
				});
			}).catch((err) => {
				post({
					type: 'fallback-entry',
					id: request.id,
					entry: originalEntryToResolved(entry),
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			});
			if (!file) continue;
			post({
				type: 'progress',
				id: request.id,
				progress: { fileIndex: i, totalFiles: request.files.length, fileName: entry.path, phase: 'writing' },
			});
			const opfsName = await writeFileToOpfs(file, `__media_upload_${request.id}_${i}_${crypto.randomUUID()}`);
			const resolvedEntry: UploadResolvedEntry = {
				originalIndex: entry.index,
				path: file.name,
				name: basename(file.name),
				parentPath: parentPath(file.name),
				size: file.size,
				originalSize: entry.file.size,
				type: file.type,
				lastModified: file.lastModified,
				source: { kind: 'opfs', opfsName },
			};
			post({ type: 'converted-entry', id: request.id, entry: resolvedEntry });
		}
		post({ type: 'done', id: request.id });
	} catch (err) {
		post({ type: 'error', id: request.id, error: err instanceof Error ? err.message : String(err) });
	}
}

function originalEntryToResolved(entry: MediaConversionWorkerFileEntry): UploadResolvedEntry {
	return {
		originalIndex: entry.index,
		path: entry.originalPath,
		name: basename(entry.originalPath),
		parentPath: parentPath(entry.originalPath),
		size: entry.file.size,
		originalSize: entry.file.size,
		type: entry.file.type,
		lastModified: entry.file.lastModified,
		source: { kind: 'file', file: entry.file },
	};
}

async function convertEntryFile(
	entry: MediaConversionWorkerFileEntry,
	request: MediaConversionWorkerRequest,
	onVideoProgress: (progress: number) => void,
): Promise<File> {
	if (request.imageCompression?.enabled === true && entry.conversionKind === 'image') {
		const file = await convertImageFile(entry.file, request.imageCompression);
		return new File([file], replaceFilename(entry.path, file.name), { type: file.type, lastModified: file.lastModified });
	}
	if (request.videoConversion?.enabled === true && entry.conversionKind === 'video') {
		const file = await convertVideoFile(entry.file, request.videoConversion, onVideoProgress);
		return new File([file], replaceFilename(entry.path, file.name), { type: file.type, lastModified: file.lastModified });
	}
	return new File([entry.file], entry.path, { type: entry.file.type, lastModified: entry.file.lastModified });
}

function replaceFilename(path: string, filename: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? `${path.slice(0, slash + 1)}${filename}` : filename;
}

function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? path : path.slice(slash + 1);
}

function parentPath(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash + 1);
}

async function writeFileToOpfs(file: File, name: string): Promise<string> {
	const root = await navigator.storage.getDirectory();
	const handle = await root.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write(file);
	await writable.close();
	return name;
}

async function deleteFromOpfs(name: string): Promise<void> {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(name).catch(() => {});
}

function post(message: MediaConversionWorkerMessage): void {
	self.postMessage(message);
}
