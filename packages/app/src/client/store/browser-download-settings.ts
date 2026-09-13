import { ref } from 'vue';

export const DEFAULT_BROWSER_DOWNLOAD_CONCURRENCY = 3;
const KEY = 'cfw_fileup_browser_download_concurrency';
export function normalizeDownloadConcurrency(value: number): number {
	return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_BROWSER_DOWNLOAD_CONCURRENCY;
}

function load(): number {
	try {
		const value = normalizeDownloadConcurrency(Number(localStorage.getItem(KEY)));
		localStorage.setItem(KEY, String(value));
		return value;
	} catch { return DEFAULT_BROWSER_DOWNLOAD_CONCURRENCY; }
}

export const browserDownloadConcurrency = ref(load());
export function setBrowserDownloadConcurrency(value: number): void {
	browserDownloadConcurrency.value = normalizeDownloadConcurrency(value);
	try { localStorage.setItem(KEY, String(browserDownloadConcurrency.value)); } catch { /* Session-only setting when storage is unavailable. */ }
}
