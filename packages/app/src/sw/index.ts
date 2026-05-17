import { isBgzf, createBgzfDecompressor } from 'bgzf';
import { fileTypeFromStream } from 'file-type';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Issue #15: Individual file from BGZF tar.gz
// If the filename (from Content-Disposition) does not end with .gz but the
// content bytes are gzip, decompress before handing to the browser.
type PeekResult = { rebuilt: ReadableStream<Uint8Array<ArrayBuffer>> } & (
	| { gzip: false; bgzf: false }
	| { gzip: true; bgzf: boolean }
);

async function peekStream(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<PeekResult | null> {
	const reader = body.getReader();
	const { done, value: firstChunk } = await reader.read();
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (done || !firstChunk) return null;

	const rebuilt = new ReadableStream<Uint8Array<ArrayBuffer>>({
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
	if (!gzip) return { rebuilt, gzip: false, bgzf: false };
	return { rebuilt, gzip: true, bgzf: isBgzf(firstChunk) };
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

	const decompressed = bgzf
		? rebuilt.pipeThrough(createBgzfDecompressor())
		: rebuilt.pipeThrough(new DecompressionStream('gzip'));

	const newHeaders = new Headers(response.headers);
	newHeaders.delete('Content-Length');
	newHeaders.delete('Content-Encoding');
	return new Response(decompressed, { status: response.status, headers: newHeaders });
}

async function handleFullArchive(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const decompress = url.searchParams.has('decompress');

	let originUrl = url;
	if (decompress) {
		originUrl = new URL(request.url);
		originUrl.searchParams.delete('decompress');
	}

	const response = await fetch(originUrl);
	if (!response.body) return response;

	const peek = await peekStream(response.body);
	console.log(request.url, peek);
	if (!peek) return response;
	const { rebuilt, bgzf, gzip } = peek;

	if (decompress && gzip) {
		console.log('sw: decompress', originUrl);
		const decompressed = bgzf
			? rebuilt.pipeThrough(createBgzfDecompressor())
			: rebuilt.pipeThrough(new DecompressionStream('gzip'));

		const [forTypeDetect, forBody] = decompressed.tee();
		const detected = await fileTypeFromStream(forTypeDetect);
		const mimeType = detected?.mime;

		const newHeaders = new Headers(response.headers);
		newHeaders.delete('Content-Length');
		newHeaders.delete('Content-Encoding');
		if (mimeType) {
			newHeaders.set('Content-Type', mimeType);
		} else {
			newHeaders.delete('Content-Type');
		}

		const rawFilename = url.pathname.split('/').pop() ?? '';
		const originalFilename = rawFilename.endsWith('.gz') ? rawFilename.slice(0, -3) : rawFilename;
		newHeaders.set('Content-Disposition', `attachment; filename="${originalFilename}"`);
		return new Response(forBody, { status: response.status, headers: newHeaders });
	}

	// !decompress && bgzf: re-compress BGZF to standard single-stream gzip (issue #16)
	if (!decompress && bgzf) {
		const gzipStream = rebuilt.pipeThrough(createBgzfDecompressor())
			.pipeThrough(new CompressionStream('gzip'));

		const newHeaders = new Headers(response.headers);
		newHeaders.delete('Content-Length');
		return new Response(gzipStream, { status: response.status, headers: newHeaders });
	}

	return new Response(rebuilt, { status: response.status, headers: response.headers });
}

// ---- Bulk archive (Issue #33) ----
// /sw-archive?bucket=<bucketName>&paths=<path1>,<path2>,...&filename=<name>
// Fetches each file from /d/<bucketName>/<path> and streams them as a tar archive.
// Only public files are accessible (no auth header in Service Worker).

const enc = new TextEncoder();

function writeTarString(buf: Uint8Array, offset: number, str: string, maxLen: number): void {
	buf.set(enc.encode(str).slice(0, maxLen), offset);
}

function writeTarOctal(buf: Uint8Array, offset: number, value: number, len: number): void {
	writeTarString(buf, offset, value.toString(8).padStart(len - 1, '0'), len);
}

/** Create a ustar tar header for a file entry */
function createTarHeader(name: string, size: number): Uint8Array {
	const header = new Uint8Array(512);
	writeTarString(header, 0, name, 100);
	writeTarString(header, 100, '0000644\0', 8); // file permissions
	writeTarString(header, 108, '0000000\0', 8); // uid
	writeTarString(header, 116, '0000000\0', 8); // gid
	writeTarOctal(header, 124, size, 12);         // file size
	writeTarOctal(header, 136, Math.floor(Date.now() / 1000), 12); // mtime
	header.fill(32, 148, 156); // checksum placeholder (spaces)
	header[156] = 48; // type '0' = regular file
	writeTarString(header, 257, 'ustar', 5);
	writeTarString(header, 263, '00', 2);
	// calculate and write checksum
	let checksum = 0;
	for (let i = 0; i < 512; i++) checksum += header[i];
	writeTarString(header, 148, checksum.toString(8).padStart(6, '0'), 6);
	header[154] = 0;
	header[155] = 32;
	return header;
}

/**
 * Generate a tar archive stream from a list of (path, url) pairs.
 * Files are fetched sequentially to avoid memory spikes.
 *
 * Note: The size of each file must be known before writing its header.
 * We therefore read the Content-Length header first; if it is missing,
 * we buffer the entire file in memory to get the size.
 */
async function* generateTarEntries(files: Array<{ name: string; url: string }>): AsyncGenerator<Uint8Array> {
	for (const { name, url } of files) {
		let res: Response;
		try {
			res = await fetch(url);
		} catch {
			console.warn(`sw-archive: failed to fetch ${url}`);
			continue;
		}
		if (!res.ok || !res.body) {
			console.warn(`sw-archive: ${url} returned ${res.status}`);
			continue;
		}

		const contentLength = res.headers.get('Content-Length');
		if (contentLength !== null) {
			// Size known — stream directly without buffering
			const size = parseInt(contentLength, 10);
			yield createTarHeader(name, size);

			const reader = res.body.getReader();
			let bytesWritten = 0;
			try {
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					yield value;
					bytesWritten += value.length;
				}
			} finally {
				reader.releaseLock();
			}
			// Padding to 512-byte boundary
			const pad = (512 - (bytesWritten % 512)) % 512;
			if (pad > 0) yield new Uint8Array(pad);
		} else {
			// Content-Length missing — buffer entire file to get size
			const blob = await res.blob();
			const size = blob.size;
			yield createTarHeader(name, size);

			const reader = blob.stream().getReader();
			try {
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					yield value;
				}
			} finally {
				reader.releaseLock();
			}
			// Padding to 512-byte boundary
			const pad = (512 - (size % 512)) % 512;
			if (pad > 0) yield new Uint8Array(pad);
		}
	}

	// End-of-archive: two 512-byte zero blocks
	yield new Uint8Array(1024);
}

function handleBulkArchive(request: Request): Response {
	const url = new URL(request.url);
	const bucket = url.searchParams.get('bucket') ?? '';
	const filename = url.searchParams.get('filename') ?? 'archive.tar';
	const pathsParam = url.searchParams.get('paths') ?? '';

	if (!bucket || !pathsParam) {
		return new Response('Missing bucket or paths parameter', { status: 400 });
	}

	// Paths are encoded as comma-separated URL-encoded strings
	const paths = pathsParam.split(',').map(p => decodeURIComponent(p)).filter(Boolean);
	if (paths.length === 0) {
		return new Response('No files specified', { status: 400 });
	}

	const files = paths.map(p => ({
		// Use the last path segment as the file name within the archive
		name: p,
		url: `/d/${bucket}/${p}`,
	}));

	const gen = generateTarEntries(files);
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done } = await gen.next();
				if (done) {
					controller.close();
				} else {
					controller.enqueue(value);
				}
			} catch (err) {
				controller.error(err);
			}
		},
		cancel() {
			gen.return(undefined as unknown as Uint8Array);
		},
	});

	const headers = new Headers({
		'Content-Type': 'application/x-tar',
		'Content-Disposition': `attachment; filename="${filename}"`,
	});

	return new Response(stream, { status: 200, headers });
}

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);

	// Bulk archive endpoint (Issue #33)
	if (url.pathname === '/sw-archive') {
		event.respondWith(handleBulkArchive(event.request));
		return;
	}

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
