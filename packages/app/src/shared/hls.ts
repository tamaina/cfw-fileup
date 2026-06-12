export const HLS_TAR_MIME = 'application/vnd.cfw-fileup.hls+tar';

export const HLS_POSTER_NAME = 'poster.jpg';
export const HLS_SESSION_DATA_TITLE_ID = 'com.cfw-fileup.hls.title';
export const HLS_SESSION_DATA_POSTER_ID = 'com.cfw-fileup.hls.poster';

export interface HlsSessionMetadata {
	title: string | null;
	posterUri: string | null;
}

/** EXT-X-SESSION-DATA の VALUE/URI に安全に入れられる形へ(quoted-string なので " と改行は使えない) */
function sanitizeQuotedString(value: string): string {
	return value.replace(/["\r\n]/g, '');
}

export function buildHlsSessionDataLines(meta: { title?: string; posterUri?: string }): string[] {
	const lines: string[] = [];
	if (meta.title !== undefined && meta.title !== '') {
		lines.push(`#EXT-X-SESSION-DATA:DATA-ID="${HLS_SESSION_DATA_TITLE_ID}",VALUE="${sanitizeQuotedString(meta.title)}"`);
	}
	if (meta.posterUri !== undefined && meta.posterUri !== '') {
		lines.push(`#EXT-X-SESSION-DATA:DATA-ID="${HLS_SESSION_DATA_POSTER_ID}",URI="${sanitizeQuotedString(meta.posterUri)}"`);
	}
	return lines;
}

/**
 * マスタープレイリストに EXT-X-SESSION-DATA 行を挿入する。
 * #EXTM3U(とそれに続く #EXT-X-VERSION)の直後に入れる。
 */
export function insertHlsSessionData(masterText: string, lines: string[]): string {
	if (lines.length === 0) return masterText;
	const sourceLines = masterText.split('\n');
	let insertIndex = 0;
	for (let i = 0; i < sourceLines.length; i++) {
		const line = sourceLines[i].trim();
		if (line === '#EXTM3U' || line.startsWith('#EXT-X-VERSION:')) {
			insertIndex = i + 1;
			continue;
		}
		if (line !== '') break;
	}
	return [...sourceLines.slice(0, insertIndex), ...lines, ...sourceLines.slice(insertIndex)].join('\n');
}

/** EXT-X 属性リスト(KEY=VALUE,KEY="VALUE",...)のパース */
export function parseHlsAttributeList(input: string): Record<string, string> {
	const result: Record<string, string> = {};
	const matches = input.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g);
	for (const match of matches) {
		result[match[1]] = match[2].replace(/^"|"$/g, '');
	}
	return result;
}

export function parseHlsSessionData(masterText: string): HlsSessionMetadata {
	const meta: HlsSessionMetadata = { title: null, posterUri: null };
	for (const rawLine of masterText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith('#EXT-X-SESSION-DATA:')) continue;
		const attrs = parseHlsAttributeList(line.slice('#EXT-X-SESSION-DATA:'.length));
		if (attrs['DATA-ID'] === HLS_SESSION_DATA_TITLE_ID && attrs.VALUE) meta.title = attrs.VALUE;
		if (attrs['DATA-ID'] === HLS_SESSION_DATA_POSTER_ID && attrs.URI) meta.posterUri = attrs.URI;
	}
	return meta;
}

export function hlsEntryDirname(entryPath: string): string {
	const slash = entryPath.lastIndexOf('/');
	return slash === -1 ? '' : entryPath.slice(0, slash);
}

/** master.m3u8 のエントリーパスから、隣に置かれるポスターのエントリーパスを得る */
export function hlsPosterEntryPath(masterEntryPath: string): string {
	const dir = hlsEntryDirname(masterEntryPath);
	return dir === '' ? HLS_POSTER_NAME : `${dir}/${HLS_POSTER_NAME}`;
}
