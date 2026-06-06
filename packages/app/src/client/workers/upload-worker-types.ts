import type { FileVisibility } from '../../shared/file-visibility';

export type UploadJobMode = 'individual' | 'gz' | 'tar' | 'targz';
export type UploadJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface UploadWorkerFileEntry {
	path: string;
	file: File;
}

export interface UploadImageCompressionOptions {
	enabled: boolean;
	quality: number;
	maxWidth: number;
	maxHeight: number;
	mimeType: 'image/jpeg' | 'image/webp';
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
	partSize: number;
	nonResumeUploadLimitBytes: number;
	files: UploadWorkerFileEntry[];
	totalBytes: number;
	authToken: string | null;
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
	error?: string;
}

export type UploadWorkerClientMessage =
	| { type: 'subscribe' }
	| { type: 'enqueue'; job: UploadJobRequest };

export type UploadWorkerServerMessage =
	| { type: 'snapshot'; jobs: UploadJobSnapshot[] }
	| { type: 'enqueued'; jobId: string };
