import { createApp } from 'vue';
import './styles/main.css';
import App from './App.vue';

import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createStoragePlugin, createThemePlugin, V0StyleSheetThemeAdapter } from '@vuetify/v0';
import { WagmiPlugin } from '@wagmi/vue';
import { wagmiConfig } from './wagmi';

type ThemeName = 'light' | 'dark';

const OLD_KEY = 'cfw-fileup-theme';

function getInitialTheme(): ThemeName {
	const oldSaved = localStorage.getItem(OLD_KEY);
	if (oldSaved) localStorage.removeItem(OLD_KEY);
	if (oldSaved === 'light' || oldSaved === 'dark') return oldSaved;
	return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const themes = {
	light: {
		dark: false,
		colors: {
			'primary': '#4f46e5',
			'primary-hover': '#4338ca',
			'primary-active': '#3730a3',
			'primary-fg': '#ffffff',
			'danger': '#dc2626',
			'danger-hover': '#b91c1c',
			'success': '#16a34a',
			'warning': '#d97706',
			'bg': '#f1f5f9',
			'surface': '#ffffff',
			'border': '#e2e8f0',
			'border-focus': '#4f46e5',
			'text': '#0f172a',
			'text-muted': '#64748b',
			'text-subtle': '#94a3b8',
			'on-background': '#0f172a',
		},
	},
	dark: {
		dark: true,
		colors: {
			'primary': '#828efc',
			'primary-hover': '#6366f1',
			'primary-active': '#4f46e5',
			'primary-fg': '#ffffff',
			'danger': '#f87171',
			'danger-hover': '#ef4444',
			'success': '#4ade80',
			'warning': '#fbbf24',
			'bg': '#0c1322',
			'surface': '#142033',
			'border': '#334155',
			'border-focus': '#818cf8',
			'text': '#f1f5f9',
			'text-muted': '#aeb6c2',
			'text-subtle': '#475569',
			'on-background': '#f1f5f9',
		},
	},
} as const;

const queryClient = new QueryClient();

createApp(App)
	.use(createStoragePlugin())
	.use(createThemePlugin({
		default: getInitialTheme(),
		persist: true,
		target: 'body',
		adapter: new V0StyleSheetThemeAdapter({ prefix: 'color' }),
		themes,
	}))
	.use(VueQueryPlugin, { queryClient })
	.use(WagmiPlugin, { config: wagmiConfig })
	.mount('#app');
