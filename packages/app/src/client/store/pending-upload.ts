import { ref } from 'vue';
import type { UploadTree } from '@/utils/upload-tree';

export const pendingTree = ref<UploadTree | null>(null);
export const pendingBucketName = ref('');
export const pendingPrefix = ref('');

let _pendingSet = false;

export function setPendingUpload(tree: UploadTree, bucketName: string, prefix: string): void {
	pendingTree.value = tree;
	pendingBucketName.value = bucketName;
	pendingPrefix.value = prefix;
	_pendingSet = true;
}

export function takePendingUpload(): { tree: UploadTree; bucketName: string; prefix: string } | null {
	if (!_pendingSet) return null;
	if (!pendingTree.value) throw new Error('Pending upload tree is missing');
	const result = { tree: pendingTree.value, bucketName: pendingBucketName.value, prefix: pendingPrefix.value };
	pendingTree.value = null;
	pendingBucketName.value = '';
	pendingPrefix.value = '';
	_pendingSet = false;
	return result;
}
