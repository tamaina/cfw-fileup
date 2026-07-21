export interface ArchivePreviewRequest {
	type: 'preview';
	requestId: string;
	consumerId: string;
	archiveId: string;
	entryId: string;
	url: string;
	encryptionKey: string;
	mimeType: string;
	headers: Record<string, string>;
}

export type ArchivePreviewWorkerRequest = ArchivePreviewRequest
	| { type: 'cancel-consumer'; consumerId: string }
	| { type: 'evict'; archiveId: string; entryId: string; encryptionKey: string }
	| { type: 'clear-context'; archiveId: string; encryptionKey: string }
	| { type: 'clear-all' };

export type ArchivePreviewWorkerResponse = {
	type: 'result';
	requestId: string;
	entryId: string;
	blob: Blob;
} | {
	type: 'error';
	requestId: string;
	entryId: string;
	error: string;
} | {
	type: 'cancelled';
	requestId: string;
	entryId: string;
};
