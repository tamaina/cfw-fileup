import { ref } from 'vue';

export const DEFAULT_BROWSER_UPLOAD_PART_SIZE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_NON_RESUME_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024;
export const MIN_BROWSER_UPLOAD_SETTING_BYTES = 32 * 1024 * 1024;

const AUTO_OPEN_KEY = 'cfw_fileup_browser_upload_auto_open';
const PART_SIZE_KEY = 'cfw_fileup_browser_upload_part_size';
const NON_RESUME_LIMIT_KEY = 'cfw_fileup_browser_upload_non_resume_limit';

export const browserUploadAutoOpen = ref(loadBoolean(AUTO_OPEN_KEY, true));
export const browserUploadPartSizeBytes = ref(loadBytes(PART_SIZE_KEY, DEFAULT_BROWSER_UPLOAD_PART_SIZE_BYTES));
export const browserUploadNonResumeLimitBytes = ref(loadBytes(NON_RESUME_LIMIT_KEY, DEFAULT_NON_RESUME_UPLOAD_LIMIT_BYTES));

export function setBrowserUploadAutoOpen(value: boolean): void {
	browserUploadAutoOpen.value = value;
	localStorage.setItem(AUTO_OPEN_KEY, value ? 'true' : 'false');
}

export function setBrowserUploadPartSizeBytes(value: number): void {
	const bytes = normalizeBytes(value, DEFAULT_BROWSER_UPLOAD_PART_SIZE_BYTES);
	browserUploadPartSizeBytes.value = bytes;
	localStorage.setItem(PART_SIZE_KEY, String(bytes));
}

export function setBrowserUploadNonResumeLimitBytes(value: number): void {
	const bytes = normalizeBytes(value, DEFAULT_NON_RESUME_UPLOAD_LIMIT_BYTES);
	browserUploadNonResumeLimitBytes.value = bytes;
	localStorage.setItem(NON_RESUME_LIMIT_KEY, String(bytes));
}

function loadBoolean(key: string, fallback: boolean): boolean {
	const raw = localStorage.getItem(key);
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	return fallback;
}

function loadBytes(key: string, fallback: number): number {
	const value = Number(localStorage.getItem(key));
	return normalizeBytes(value, fallback);
}

function normalizeBytes(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(MIN_BROWSER_UPLOAD_SETTING_BYTES, Math.floor(value));
}
