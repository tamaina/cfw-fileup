import { extractZipFile, ZipInvalidPasswordError, type ZipExtractProgress } from '@/utils/zip-extract';

export type ZipExtractWorkerRequest = {
	readonly id: string;
	readonly file: File;
	readonly password?: string;
};

export type ZipExtractWorkerMessage =
	| { type: 'progress'; id: string; progress: ZipExtractProgress }
	| { type: 'done'; id: string; entries: { path: string; file: File }[]; warnings: string[]; needsPassword: boolean }
	| { type: 'invalid-password'; id: string }
	| { type: 'error'; id: string; error: string };

self.onmessage = (event: MessageEvent<ZipExtractWorkerRequest>) => {
	void handleRequest(event.data);
};

async function handleRequest(request: ZipExtractWorkerRequest): Promise<void> {
	try {
		const result = await extractZipFile(request.file, {
			password: request.password,
			onProgress: progress => post({ type: 'progress', id: request.id, progress }),
		});
		post({ type: 'done', id: request.id, entries: result.entries, warnings: result.warnings, needsPassword: result.needsPassword });
	} catch (err) {
		if (err instanceof ZipInvalidPasswordError) {
			post({ type: 'invalid-password', id: request.id });
			return;
		}
		post({ type: 'error', id: request.id, error: err instanceof Error ? err.message : String(err) });
	}
}

function post(message: ZipExtractWorkerMessage): void {
	self.postMessage(message);
}
