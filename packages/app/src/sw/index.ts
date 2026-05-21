declare global {
	interface WorkerGlobalScope {
		__WB_MANIFEST: unknown[];
	}
}

const sw = self as unknown as ServiceWorkerGlobalScope;
void self.__WB_MANIFEST;

sw.skipWaiting();
sw.addEventListener('activate', (event) => {
	event.waitUntil(sw.clients.claim());
});
