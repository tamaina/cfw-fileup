import { parseEaidx } from '../../shared/eaid-x';
import type { files, fileAccessTokens } from '../scheme/index';

type FileRecord = typeof files.$inferSelect;
type FileAccessTokenRecord = typeof fileAccessTokens.$inferSelect;

type CacheMode = 'plain' | 'tar-entry' | 'targz-entry';
type CacheTarget = {
	mode: CacheMode;
	entryPath?: string;
};
type CacheAuth =
	| { type: 'public' }
	| { type: 'token'; tokenId: string };

type AuthContext =
	| { type: 'public' }
	| { type: 'file-token'; token: FileAccessTokenRecord }
	| { type: 'expired-file-token'; token: FileAccessTokenRecord }
	| { type: 'user' };

const publicCacheControl = `public, max-age=${10 * 365 * 24 * 60 * 60}, immutable`;
const internalStatusHeader = 'X-Cfw-Fileup-Cache-Status';
const internalStatusTextHeader = 'X-Cfw-Fileup-Cache-Status-Text';
const downloadVaryHeaders = ['Authentication', 'Authorization', 'Accept-Encoding'] as const;

export const downloadCacheInternalHeaders = {
	status: internalStatusHeader,
	statusText: internalStatusTextHeader,
} as const;

function toAsciiFilenameFallback(filename: string): string {
	const fallback = filename
		.replace(/[^\x20-\x7e]/g, '_')
		.replace(/["\\]/g, '_')
		.trim();
	return fallback || 'download';
}

function buildContentDisposition(filename: string): string {
	const fallback = toAsciiFilenameFallback(filename);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function appendVary(headers: Headers, values: readonly string[]): void {
	const existing = headers.get('Vary');
	const existingValues = new Set(
		existing
			?.split(',')
			.map((value) => value.trim())
			.filter((value) => value.length > 0)
			.map((value) => value.toLowerCase()) ?? [],
	);
	const nextValues = existing
		?.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0) ?? [];
	for (const value of values) {
		if (existingValues.has(value.toLowerCase())) continue;
		nextValues.push(value);
		existingValues.add(value.toLowerCase());
	}
	headers.set('Vary', nextValues.join(', '));
}

export function createDownloadCacheRequest(options: {
	fileId: string;
	mode: CacheMode;
	gzip: boolean;
	auth: CacheAuth;
	entryPath?: string;
}): Request {
	const keyUrl = new URL('https://cache.cfw-fileup.local/download');
	keyUrl.searchParams.set('v', '1');
	keyUrl.searchParams.set('fileId', options.fileId);
	keyUrl.searchParams.set('mode', options.mode);
	keyUrl.searchParams.set('gzip', options.gzip ? '1' : '0');

	if (options.entryPath !== undefined) {
		keyUrl.searchParams.set('entry', options.entryPath);
	}

	if (options.auth.type === 'token') {
		keyUrl.searchParams.set('auth', `token:${options.auth.tokenId}`);
	} else {
		keyUrl.searchParams.set('auth', 'public');
	}

	return new Request(keyUrl, { method: 'GET' });
}

export class DownloadContext {
	readonly url: URL;
	readonly acceptsGzip: boolean;
	readonly fileQuery: string | null;
	readonly isListMode: boolean;
	readonly isMetaMode: boolean;
	readonly lastModified: Date;

	private authContext: AuthContext;

	constructor(
		readonly file: FileRecord,
		request: Request,
	) {
		this.url = new URL(request.url);
		this.acceptsGzip = request.headers.get('Accept-Encoding')?.includes('gzip') ?? false;
		this.fileQuery = this.url.searchParams.get('file');
		this.isListMode = this.url.searchParams.has('list');
		this.isMetaMode = this.url.searchParams.has('meta');
		this.lastModified = parseEaidx(file.id).date;
		this.authContext = file.visibility === 'public' ? { type: 'public' } : { type: 'user' };
	}

	get isTarFileEntry(): boolean {
		return this.file.isTar && this.fileQuery !== null;
	}

	get isTargzFileEntry(): boolean {
		return this.file.isTargz && this.fileQuery !== null;
	}

	get canUseCache(): boolean {
		return this.authContext.type === 'public' || this.authContext.type === 'file-token' || this.authContext.type === 'expired-file-token';
	}

	get cacheTarget(): CacheTarget | null {
		if (this.isListMode) return null;
		if (this.isTarFileEntry && this.fileQuery !== null) {
			return { mode: 'tar-entry', entryPath: this.fileQuery };
		}
		if (this.isTargzFileEntry && this.fileQuery !== null) {
			return { mode: 'targz-entry', entryPath: this.fileQuery };
		}
		return { mode: 'plain' };
	}

	useFileToken(token: FileAccessTokenRecord): void {
		this.authContext = { type: 'file-token', token };
	}

	useExpiredFileToken(token: FileAccessTokenRecord): void {
		this.authContext = { type: 'expired-file-token', token };
	}

	createContentDisposition(
		filename: string,
		transform?: (filename: string, context: DownloadContext) => string,
	): string {
		const displayName = transform?.(filename, this) ?? filename;
		return buildContentDisposition(displayName);
	}

	getETag(entryPath?: string): string {
		const parts = [this.file.id];
		if (entryPath !== undefined) parts.push(entryPath);
		const suffix = this.acceptsGzip ? '' : '-gz';
		return `"${parts.map((part) => encodeURIComponent(part)).join('-')}${suffix}"`;
	}

	withDownloadHeaders(headers: HeadersInit): HeadersInit {
		const expiresAt = this.authContext.type === 'file-token' ? this.authContext.token.expiresAt : null;
		const nextHeaders = new Headers(headers);
		nextHeaders.set('Last-Modified', this.lastModified.toUTCString());
		appendVary(nextHeaders, downloadVaryHeaders);
		if (this.authContext.type === 'public') {
			nextHeaders.set('Cache-Control', publicCacheControl);
			return nextHeaders;
		}
		if (expiresAt === null) return nextHeaders;
		nextHeaders.set('Expires', new Date(expiresAt).toUTCString());
		return nextHeaders;
	}

	getInternalCacheControl(): string {
		if (this.authContext.type === 'expired-file-token') return publicCacheControl;
		if (this.authContext.type !== 'file-token') return publicCacheControl;
		if (this.authContext.token.expiresAt === null) return publicCacheControl;
		const maxAge = Math.max(0, Math.floor((this.authContext.token.expiresAt - Date.now()) / 1000));
		return `public, max-age=${maxAge}`;
	}

	getCacheRequest(mode: CacheMode, entryPath?: string): Request | null {
		if (!this.canUseCache) return null;
		const auth: CacheAuth = this.authContext.type === 'file-token' || this.authContext.type === 'expired-file-token'
			? { type: 'token', tokenId: this.authContext.token.id }
			: { type: 'public' };
		return createDownloadCacheRequest({
			fileId: this.file.id,
			mode,
			entryPath,
			gzip: this.acceptsGzip,
			auth,
		});
	}

	stripInternalCacheHeaders(cached: Response, mode: CacheMode): Response {
		const headers = new Headers(cached.headers);
		const cachedStatus = Number(headers.get(internalStatusHeader));
		const status = Number.isInteger(cachedStatus) && cachedStatus >= 100 && cachedStatus <= 599
			? cachedStatus
			: cached.status;
		const statusText = headers.get(internalStatusTextHeader) ?? cached.statusText;
		headers.delete(internalStatusHeader);
		headers.delete(internalStatusTextHeader);
		if (this.authContext.type === 'public') {
			headers.set('Cache-Control', publicCacheControl);
		} else {
			headers.delete('Cache-Control');
		}
		return new Response(cached.body, {
			status,
			statusText,
			headers,
			...(mode === 'targz-entry' ? { encodeBody: 'manual' } : {}),
		});
	}
}
