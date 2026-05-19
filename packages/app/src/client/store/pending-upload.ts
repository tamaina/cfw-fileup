import { ref } from 'vue';

export const pendingFiles = ref<File[]>([]);
export const pendingBucketName = ref('');
export const pendingPrefix = ref('');

let _pendingSet = false;

export function setPendingUpload(files: File[], bucketName: string, prefix: string): void {
	pendingFiles.value = files;
	pendingBucketName.value = bucketName;
	pendingPrefix.value = prefix;
	_pendingSet = true;
}

export function takePendingUpload(): { files: File[]; bucketName: string; prefix: string } | null {
	if (!_pendingSet) return null;
	const result = { files: pendingFiles.value, bucketName: pendingBucketName.value, prefix: pendingPrefix.value };
	pendingFiles.value = [];
	pendingBucketName.value = '';
	pendingPrefix.value = '';
	_pendingSet = false;
	return result;
}
