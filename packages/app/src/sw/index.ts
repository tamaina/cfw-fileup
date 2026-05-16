import { isBgzf, createBgzfDecompressor } from 'bgzf';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Issue #15: Individual file from BGZF tar.gz
// If the filename (from Content-Disposition) does not end with .gz but the
// content bytes are gzip, decompress before handing to the browser.
type PeekResult = { rebuilt: ReadableStream<Uint8Array>; gzip: boolean; bgzf: boolean };

async function peekStream(body: ReadableStream<Uint8Array>): Promise<PeekResult | null> {
	const reader = body.getReader();
	const { done, value: firstChunk } = await reader.read();
	if (done || !firstChunk) return null;

	const rebuilt = new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(firstChunk); },
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
		},
		cancel() { reader.releaseLock(); },
	});

	const gzip = firstChunk.length >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;
  return { rebuilt, gzip, bgzf: gzip && isBgzf(firstChunk) };
}

// Issue #16: Full BGZF archive → standard single-stream gzip
async function handleFileInArchive(request: Request): Promise<Response> {
	const response = await fetch(request);
	if (!response.body) return response;

	// If the user explicitly wants a .gz file, serve raw bytes as-is
	const disposition = response.headers.get('content-disposition') ?? '';
	const filenameMatch = disposition.match(/filename="([^"]+)"/i);
	const filename = filenameMatch ? filenameMatch[1] : '';
	if (filename.toLowerCase().endsWith('.gz')) return response;

	const peek = await peekStream(response.body);
	if (!peek) return response;
	const { rebuilt, gzip, bgzf } = peek;

	if (!gzip) {
		return new Response(rebuilt, { status: response.status, headers: response.headers });
	}

	// BGZF uses concatenated gzip blocks; regular gzip uses DecompressionStream directly.
	// Uint8Array satisfies BufferSource, so widening rebuilt before pipeThrough is safe.
	const decompressed = bgzf
		? rebuilt.pipeThrough(createBgzfDecompressor())
		: (rebuilt as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream('gzip'));

	const newHeaders = new Headers(response.headers);
	newHeaders.delete('Content-Length');
  newHeaders.delete('Content-Encoding');
	return new Response(decompressed as ReadableStream<Uint8Array>, { status: response.status, headers: newHeaders });
}

async function handleFullArchive(request: Request): Promise<Response> {
	const response = await fetch(request);
	if (!response.body) return response;

	const peek = await peekStream(response.body);
	if (!peek) return response;
	const { rebuilt, bgzf } = peek;

	if (!bgzf) {
		return new Response(rebuilt, { status: response.status, headers: response.headers });
	}

	const gzipStream = (rebuilt.pipeThrough(createBgzfDecompressor()) as ReadableStream<BufferSource>)
		.pipeThrough(new CompressionStream('gzip'));

	const newHeaders = new Headers(response.headers);
	newHeaders.delete('Content-Length');
	return new Response(gzipStream, { status: response.status, headers: newHeaders });
}

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	if (!url.pathname.startsWith('/d/')) return;

	const params = url.searchParams;
	if (params.has('file')) {
		event.respondWith(handleFileInArchive(event.request));
	} else if (!params.has('list')) {
    event.respondWith(handleFullArchive(event.request));
	}
});

sw.skipWaiting();
sw.addEventListener('activate', (event) => {
	event.waitUntil(sw.clients.claim());
});
