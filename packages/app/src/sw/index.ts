import { installStreamDownloads } from './stream-download';
import { putShareTargetPayload, type ShareTargetFileEntry } from '../shared/share-target-store';

declare global {
	interface WorkerGlobalScope {
		__WB_MANIFEST: unknown[];
	}
}

const sw = self as unknown as ServiceWorkerGlobalScope;
void self.__WB_MANIFEST;

installStreamDownloads(sw);

sw.skipWaiting();
sw.addEventListener('activate', (event) => {
	event.waitUntil(sw.clients.claim());
});

sw.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'POST' || url.pathname !== '/share-target') return;
	event.respondWith(handleShareTarget(event.request));
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const data = event.notification.data as { url?: string } | undefined;
	const targetUrl = data?.url ?? '/my/uploadings?tab=browser';
	event.waitUntil(openOrFocusClient(targetUrl));
});

async function handleShareTarget(request: Request): Promise<Response> {
	const id = crypto.randomUUID();
	const formData = await request.formData();
	const files = formData.getAll('files')
		.filter((value): value is File => value instanceof File)
		.map(toShareTargetFileEntry);

	if (files.length > 0) {
		await putShareTargetPayload({ id, createdAt: Date.now(), files });
	}

	const targetUrl = files.length > 0
		? `/uploader?shareTarget=${encodeURIComponent(id)}`
		: '/uploader?shareTarget=empty';

	return Response.redirect(targetUrl, 303);
}

function toShareTargetFileEntry(file: File): ShareTargetFileEntry {
	return {
		file,
		name: file.name,
		type: file.type,
		lastModified: file.lastModified,
	};
}

async function openOrFocusClient(path: string): Promise<void> {
	const targetUrl = new URL(path, sw.location.origin).href;
	const clientList = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
	for (const client of clientList) {
		if ('focus' in client) {
			await client.focus();
			if ('navigate' in client) await client.navigate(targetUrl);
			return;
		}
	}
	await sw.clients.openWindow(targetUrl);
}

export {};
