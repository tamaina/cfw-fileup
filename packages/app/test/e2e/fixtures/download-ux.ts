import { createApp } from 'vue';
import Archive from '../../../src/client/pages/browse.directory.vue';
import File from '../../../src/client/pages/browse.file.vue';

export function mountDownload(kind: 'archive' | 'file', key: string): void {
	const container = document.createElement('div');
	container.id = 'download-ux';
	document.body.append(container);
	createApp(kind === 'archive' ? Archive : File, {
		bucketName: 'test', filePath: kind === 'archive' ? 'example.tar' : 'example.bin', fileId: 'ux-fixture',
		bucketId: null, isTargz: false, isTar: kind === 'archive', isEncrypted: true, encryptionKey: key,
		mimeType: 'application/octet-stream', showAds: false,
	}).mount(container);
}
