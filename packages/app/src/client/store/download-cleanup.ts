import { removeOpfsTempFile } from '@/workers/opfs-temp';

const objectUrls = new Set<string>();
const opfsNames = new Set<string>();
let registered = false;

function cleanupDownloadedFiles(): void {
	for (const url of objectUrls) URL.revokeObjectURL(url);
	objectUrls.clear();
	const names = Array.from(opfsNames);
	opfsNames.clear();
	for (const name of names) void removeOpfsTempFile(name);
}

function ensureCleanupListener(): void {
	if (registered || typeof window === 'undefined') return;
	window.addEventListener('pagehide', cleanupDownloadedFiles);
	registered = true;
}

export function registerDownloadedOpfsFile(url: string, opfsName: string): void {
	ensureCleanupListener();
	objectUrls.add(url);
	opfsNames.add(opfsName);
}
