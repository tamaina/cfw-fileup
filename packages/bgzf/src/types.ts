/** A file to include in a tar or BGZF tar archive. */
export interface FileEntry {
	path: string;
	file: File;
	/** Explicit MIME type hint. When provided (e.g. for encrypted entries where magic-byte detection is impossible), this takes priority over detection. */
	mimeType?: string;
}

/** Index entry for a file within a BGZF-compressed tar archive. */
export interface TarGzIndex {
	path: string;
	mimeType: string;
	aStart: number;
	aFirstEnd: number;
	aFinalStart: number;
	aEnd: number;
	rStartOffset: number;
	rEndOffset: number;
}

/** Index entry for a file within a plain tar archive. */
export interface TarIndex {
	path: string;
	mimeType: string;
	offset: number;
	size: number;
}

export interface ArchiveProgress {
	processedFiles: number;
	totalFiles: number;
	currentFile: string;
	processedBytes: number;
	totalBytes: number;
}

