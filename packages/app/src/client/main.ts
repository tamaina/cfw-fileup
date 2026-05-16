import { createApp } from 'vue';
import './styles/main.css';
import App from './App.vue';

import { createStoragePlugin, createThemePlugin, V0StyleSheetThemeAdapter } from '@vuetify/v0';

// Migrate old key and detect initial theme
const OLD_KEY = 'cfw-fileup-theme';
const oldSaved = localStorage.getItem(OLD_KEY);
let initialTheme: 'light' | 'dark';
if (oldSaved === 'light' || oldSaved === 'dark') {
	initialTheme = oldSaved;
} else {
	initialTheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
if (oldSaved) localStorage.removeItem(OLD_KEY);

createApp(App)
	.use(createStoragePlugin())
	.use(createThemePlugin({
		default: initialTheme,
		persist: true,
		target: 'body',
		adapter: new V0StyleSheetThemeAdapter({ prefix: 'color' }),
		themes: {
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
					'primary': '#818cf8',
					'primary-hover': '#6366f1',
					'primary-active': '#4f46e5',
					'primary-fg': '#ffffff',
					'danger': '#f87171',
					'danger-hover': '#ef4444',
					'success': '#4ade80',
					'warning': '#fbbf24',
					'bg': '#0f172a',
					'surface': '#1e293b',
					'border': '#334155',
					'border-focus': '#818cf8',
					'text': '#f1f5f9',
					'text-muted': '#94a3b8',
					'text-subtle': '#475569',
					'on-background': '#f1f5f9',
				},
			},
		},
	}))
	.mount('#app');
