import { decryptBlob, importAesCtrKey, multibaseToKey } from '../../shared/encryption';
import { resizeAndConvertImage } from '@browser-mc/browser-image-resizer-ex';
import { ArchivePreviewQueue } from './archive-preview-queue';
import type { ArchivePreviewRequest, ArchivePreviewWorkerRequest, ArchivePreviewWorkerResponse } from './archive-preview-worker-types';

const cryptoKeys = new Map<string, Promise<CryptoKey>>();

function getCryptoKey(encryptionKey: string): Promise<CryptoKey> {
	let key = cryptoKeys.get(encryptionKey);
	if (key) return key;
	const rawKey = multibaseToKey(encryptionKey);
	if (!rawKey) return Promise.reject(new Error('Invalid encryption key'));
	key = importAesCtrKey(rawKey, ['decrypt']);
	cryptoKeys.set(encryptionKey, key);
	return key;
}

async function loadPreview(request: ArchivePreviewRequest, signal: AbortSignal): Promise<Blob> {
	const [cryptoKey, response] = await Promise.all([
		getCryptoKey(request.encryptionKey),
		fetch(request.url, { headers: request.headers, signal }),
	]);
	if (!response.ok) throw new Error(`Failed to fetch preview: HTTP ${response.status}`);
	const decrypted = await decryptBlob(await response.blob(), cryptoKey);
	const thumbnail = await resizeAndConvertImage({
		input: decrypted,
		inputMime: request.mimeType,
		outputMime: 'image/webp',
		width: 512,
		height: 512,
		fit: 'contain',
		animation: 'first-frame',
		exif: 'drop',
		quality: 0.8,
	});
	return thumbnail.blob;
}

const queue = new ArchivePreviewQueue({
	load: loadPreview,
	respond: message => self.postMessage(message),
});

self.onmessage = (event: MessageEvent<ArchivePreviewWorkerRequest>) => {
	const message = event.data;
	if (message.type === 'preview') queue.enqueue(message);
	if (message.type === 'cancel-consumer') queue.cancelConsumer(message.consumerId);
	if (message.type === 'evict') queue.evict(message.archiveId, message.entryId, message.encryptionKey);
	if (message.type === 'clear-context') {
		queue.clearContext(message.archiveId, message.encryptionKey);
		cryptoKeys.delete(message.encryptionKey);
	}
	if (message.type === 'clear-all') {
		queue.clearAll();
		cryptoKeys.clear();
	}
};

export type { ArchivePreviewWorkerRequest, ArchivePreviewWorkerResponse };
