/** StreamSaver.js と同じ、attachment Response にストリームを渡す方式。
 * 中継ページや外部サービスを使わず、既存 SW 内で完結する独立実装。
 */
export function installStreamDownloads(sw: ServiceWorkerGlobalScope): void {
	const prefix = '/__stream-download/';
	const pending = new Map<string, { stream: ReadableStream<Uint8Array>; filename: string; timer: ReturnType<typeof setTimeout>; port: MessagePort }>();
	sw.addEventListener('message', (event) => {
		if (event.data?.type !== 'stream-download-v1') return;
		const port = event.ports[0];
		const source = event.source;
		if (!port || !source || !('url' in source) || new URL(source.url).origin !== sw.location.origin) return;
		const { stream, filename } = event.data;
		if (!(stream instanceof ReadableStream) || typeof filename !== 'string') return;
		const path = prefix + crypto.randomUUID();
		const discard = () => {
			const entry = pending.get(path);
			if (!entry) return;
			pending.delete(path);
			clearTimeout(entry.timer);
			void entry.stream.cancel('Download was not started').catch(() => {});
			port.close();
		};
		pending.set(path, { stream, filename, port, timer: setTimeout(discard, 30_000) });
		port.onmessage = discard;
		port.postMessage({ type: 'ready', path });
	});
	sw.addEventListener('fetch', (event) => {
		const url = new URL(event.request.url);
		if (url.origin !== sw.location.origin || !url.pathname.startsWith(prefix)) return;
		const entry = pending.get(url.pathname);
		if (event.request.method !== 'GET' || !entry) {
			event.respondWith(new Response('Download expired', { status: 404 }));
			return;
		}
		pending.delete(url.pathname);
		clearTimeout(entry.timer);
		entry.port.postMessage({ type: 'started' });
		const reader = entry.stream.getReader();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				entry.port.onmessage = () => {
					controller.error(new Error('Download failed'));
					void reader.cancel('Download failed').catch(() => {});
					entry.port.close();
				};
			},
			async pull(controller) {
				try {
					const result = await reader.read();
					if (result.done) {
						controller.close();
						entry.port.close();
					} else controller.enqueue(result.value);
				} catch (error) {
					controller.error(error);
					entry.port.close();
				}
			},
			cancel(reason) {
				entry.port.close();
				return reader.cancel(reason);
			},
		});
		const filename = encodeURIComponent(entry.filename.toWellFormed().replace(/[\\/\r\n]/g, '_')).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`);
		event.respondWith(new Response(body, { headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		} }));
	});
}
