import type { FileEntry } from 'bgzf';
import { convertImageFile, convertVideoFile, convertVideoFileToHls, hlsTarArchivePath, isHlsVideoOutput, HLS_MASTER_PLAYLIST_NAME } from '@/utils/media-conversion';
import { writeTarArchiveToDirectory } from '@/utils/tar-archive';
import { HLS_TAR_MIME, HLS_POSTER_NAME, buildHlsSessionDataLines, insertHlsSessionData } from '../../shared/hls';
import type { HlsEntryUploadSettings } from '@/utils/upload-tree';
import type { UploadImageCompressionOptions, UploadResolvedEntry, UploadVideoConversionOptions, UploadWorkerFileEntry } from './upload-worker-types';

export interface MediaConversionWorkerFileEntry extends UploadWorkerFileEntry {
	index: number;
	conversionKind: 'image' | 'video';
	originalPath: string;
	hls?: HlsEntryUploadSettings;
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
			if (isHlsConversionEntry(entry, request)) {
				await convertHlsEntry(entry, request, i);
				continue;
			}
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

function isHlsConversionEntry(entry: MediaConversionWorkerFileEntry, request: MediaConversionWorkerRequest): boolean {
	return request.videoConversion?.enabled === true
		&& entry.conversionKind === 'video'
		&& isHlsVideoOutput(request.videoConversion.outputMime);
}

async function convertHlsEntry(entry: MediaConversionWorkerFileEntry, request: MediaConversionWorkerRequest, fileIndex: number): Promise<void> {
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const videoConversion = request.videoConversion!;
	const assetRecords: { path: string; mimeType: string; opfsName: string; size?: number }[] = [];
	const writes: Promise<number>[] = [];
	const opfsNames: string[] = [];
	try {
		const assets = convertVideoFileToHls(entry.file, videoConversion, (progress) => {
			post({
				type: 'progress',
				id: request.id,
				progress: {
					fileIndex,
					totalFiles: request.files.length,
					fileName: entry.path,
					phase: 'converting',
					videoProgress: progress,
				},
			});
		});
		for await (const asset of assets) {
			const opfsName = `__media_upload_${request.id}_${entry.index}_${opfsNames.length}_${crypto.randomUUID()}`;
			opfsNames.push(opfsName);
			// tar 内はルート直置き(ディレクトリプレフィックスなし)。展開時の包みは tar ファイル名側に任せる
			assetRecords.push({ path: asset.path, mimeType: asset.mimeType, opfsName });
			// プレイリスト（特に master.m3u8）のストリームは変換完了まで閉じないことがあるため、
			// 各アセットの書き込みは並行して進める（直列に await するとデッドロックする）。
			writes.push(writeStreamToOpfs(asset.data as ReadableStream<Uint8Array<ArrayBuffer>>, opfsName));
		}
		const sizes = await Promise.all(writes);
		if (assetRecords.length === 0) {
			throw new Error('HLS変換の出力を作成できませんでした。');
		}
		for (let assetIndex = 0; assetIndex < assetRecords.length; assetIndex++) {
			assetRecords[assetIndex].size = sizes[assetIndex];
		}
		const root = await navigator.storage.getDirectory();
		const hlsSettings = entry.hls;
		if (hlsSettings?.title || hlsSettings?.poster) {
			// タイトル/ポスターを master.m3u8 に EXT-X-SESSION-DATA として埋め込む（tar 化前に OPFS 上で書き換え）
			const masterRecord = assetRecords.find(record => record.path === HLS_MASTER_PLAYLIST_NAME);
			if (masterRecord) {
				const handle = await root.getFileHandle(masterRecord.opfsName);
				const text = await (await handle.getFile()).text();
				const updated = insertHlsSessionData(text, buildHlsSessionDataLines({
					title: hlsSettings.title,
					posterUri: hlsSettings.poster ? HLS_POSTER_NAME : undefined,
				}));
				const writable = await handle.createWritable();
				await writable.write(updated);
				await writable.close();
			}
		}
		const hlsEntries: FileEntry[] = await Promise.all(assetRecords.map(async record => {
			const handle = await root.getFileHandle(record.opfsName);
			const file = await handle.getFile();
			return {
				path: record.path,
				file: new File([file], basename(record.path), { type: record.mimeType, lastModified: entry.file.lastModified }),
			};
		}));
		if (hlsSettings?.poster) {
			hlsEntries.push({
				path: HLS_POSTER_NAME,
				file: new File([hlsSettings.poster], HLS_POSTER_NAME, { type: 'image/jpeg', lastModified: entry.file.lastModified }),
			});
		}
		const tarPath = hlsTarArchivePath(entry.path);
		const tarOpfsName = `__media_upload_${request.id}_${entry.index}_hls_${crypto.randomUUID()}.tar`;
		const { file: tarFile, index } = await writeTarArchiveToDirectory(hlsEntries, root, tarOpfsName);
		await Promise.all(opfsNames.map(deleteFromOpfs));
		post({
			type: 'converted-entry',
			id: request.id,
			entry: {
				originalIndex: entry.index,
				path: tarPath,
				name: basename(tarPath),
				parentPath: parentPath(tarPath),
				size: tarFile.size,
				originalSize: entry.file.size,
				type: HLS_TAR_MIME,
				lastModified: entry.file.lastModified,
				source: { kind: 'opfs', opfsName: tarOpfsName },
				archive: { kind: 'tar', files: index },
			},
		});
	} catch (err) {
		await Promise.allSettled(writes);
		await Promise.all(opfsNames.map(deleteFromOpfs));
		post({
			type: 'fallback-entry',
			id: request.id,
			entry: originalEntryToResolved(entry),
			error: err instanceof Error ? err.message : String(err),
		});
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

async function writeStreamToOpfs(stream: ReadableStream<Uint8Array<ArrayBuffer>>, name: string): Promise<number> {
	const root = await navigator.storage.getDirectory();
	const handle = await root.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	let size = 0;
	const reader = stream.getReader();
	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await writable.write(value);
			size += value.byteLength;
		}
		await writable.close();
	} catch (error) {
		reader.cancel().catch(() => {});
		await writable.abort().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	return size;
}

async function deleteFromOpfs(name: string): Promise<void> {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(name).catch(() => {});
}

function post(message: MediaConversionWorkerMessage): void {
	self.postMessage(message);
}
