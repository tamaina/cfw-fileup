import type { FileVisibility } from '../../shared/file-visibility';
import type { TarIndex } from 'bgzf';
import type { MediaImageConversionSettings, MediaVideoConversionSettings } from '../utils/media-conversion';
import type { ResolvedUploadEntry } from '../utils/upload-tree';

export type UploadJobMode = 'individual' | 'gz' | 'tar' | 'targz';
export type UploadJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface UploadWorkerFileEntry {
	source?: 'file';
	path: string;
	file: File;
}

export interface UploadWorkerOpfsEntry {
	source: 'opfs';
	path: string;
	opfsName: string;
	size: number;
	type: string;
	lastModified: number;
}

export type UploadWorkerEntry = UploadWorkerFileEntry | UploadWorkerOpfsEntry;

export interface UploadResolvedEntry extends Omit<ResolvedUploadEntry, 'source'> {
	originalSize: number;
	source:
		| { kind: 'file'; file: File }
		| { kind: 'opfs'; opfsName: string };
	archive?: { kind: 'tar'; files: TarIndex[] };
}

export interface UploadImageCompressionOptions extends MediaImageConversionSettings {
	enabled: boolean;
}

export interface UploadVideoConversionOptions extends MediaVideoConversionSettings {
	enabled: boolean;
}

export interface UploadJobRequest {
	bucketId: string;
	bucketName: string;
	prefix: string;
	mode: UploadJobMode;
	archiveBaseName: string;
	visibility: FileVisibility;
	isListed: boolean;
	passphrase?: string;
	isDownloadCountEnabled?: boolean;
	isDownloadCountVisible?: boolean;
	imageCompression?: UploadImageCompressionOptions;
	videoConversion?: UploadVideoConversionOptions;
	partSize: number;
	nonResumeUploadLimitBytes: number;
	files: UploadWorkerEntry[];
	totalBytes: number;
	authToken: string | null;
}

export interface UploadStreamingJobRequest extends Omit<UploadJobRequest, 'files' | 'imageCompression' | 'videoConversion'> {
	totalFiles: number;
	isEncrypted?: boolean;
}

export interface UploadJobSnapshot {
	id: string;
	status: UploadJobStatus;
	bucketName: string;
	prefix: string;
	mode: UploadJobMode;
	filename: string;
	fileIndex: number;
	totalFiles: number;
	uploadedBytes: number;
	totalBytes: number;
	createdAt: number;
	updatedAt: number;
	completedPath?: string;
	fileIds?: readonly string[];
	/** fileIds と同じ順序で、各ファイルの保存先パスを保持する（暗号化キーのリンク用に使う） */
	uploadedFilePaths?: readonly string[];
	error?: string;
}

export type UploadWorkerClientMessage =
	| { type: 'subscribe' }
	| { type: 'enqueue'; job: UploadJobRequest }
	| { type: 'enqueue-streaming'; requestId: string; job: UploadStreamingJobRequest }
	| { type: 'push-entry'; jobId: string; entry: UploadResolvedEntry }
	| { type: 'finish-entries'; jobId: string }
	| { type: 'fail-entries'; jobId: string; error: string }
	| { type: 'reset' };

export type UploadWorkerServerMessage =
	| { type: 'snapshot'; jobs: UploadJobSnapshot[] }
	| { type: 'enqueued'; jobId: string; requestId?: string }
	| { type: 'encryption-key'; jobId: string; key: string };
