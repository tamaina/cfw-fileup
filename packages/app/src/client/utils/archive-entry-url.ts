export function archiveEntryDownloadUrl(fileId: string, entryPath: string, token?: string | null): string {
	const base = `/d/${fileId}/${encodeURIComponent(':entries')}/${encodeURIComponent(entryPath)}`;
	return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * スラッシュを温存したアーカイブエントリーURL。
 * HLS プレイリスト内の相対パス（セグメント等）をブラウザ/hls.js に正しく解決させるために使う。
 */
export function archiveEntryStreamUrl(fileId: string, entryPath: string, token?: string | null): string {
	const encodedPath = entryPath.split('/').map(encodeURIComponent).join('/');
	const base = `/d/${fileId}/${encodeURIComponent(':entries')}/${encodedPath}`;
	return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
