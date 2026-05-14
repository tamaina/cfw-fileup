import { ref } from 'vue';

export const pendingFiles = ref<File[]>([]);
export const pendingPrefix = ref('');

let _pendingSet = false;

export function setPendingUpload(files: File[], prefix: string): void {
	pendingFiles.value = files;
	pendingPrefix.value = prefix;
	_pendingSet = true;
}

export function takePendingUpload(): { files: File[]; prefix: string } | null {
	if (!_pendingSet) return null;
	const result = { files: pendingFiles.value, prefix: pendingPrefix.value };
	pendingFiles.value = [];
	pendingPrefix.value = '';
	_pendingSet = false;
	return result;
}
