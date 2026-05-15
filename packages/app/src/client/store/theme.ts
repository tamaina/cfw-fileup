import { ref, watch } from 'vue';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'cfw-fileup-theme';

function getSystemDark(): boolean {
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function load(): Theme {
	const v = localStorage.getItem(STORAGE_KEY);
	if (v === 'light' || v === 'dark' || v === 'system') return v;
	return 'system';
}

export const theme = ref<Theme>(load());

export const isDark = ref(
	theme.value === 'dark' || (theme.value === 'system' && getSystemDark()),
);

function apply(): void {
	const dark = theme.value === 'dark' || (theme.value === 'system' && getSystemDark());
	isDark.value = dark;
	document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

watch(theme, (v) => {
	localStorage.setItem(STORAGE_KEY, v);
	apply();
}, { immediate: true });

const mq = window.matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change', () => { if (theme.value === 'system') apply(); });

export function toggleTheme(): void {
	theme.value = isDark.value ? 'light' : 'dark';
}
