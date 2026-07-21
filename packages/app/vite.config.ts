import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

const devTunnelName = process.env.CF_DEV_TUNNEL;
const wranglerConfigPath = process.env.CF_WRANGLER_CONFIG_PATH ?? './wrangler.jsonc';
const require = createRequire(import.meta.url);
const rootPackageJson = require('../../package.json') as { repository?: string | { url?: string } };
const viemPackageJson = require('viem/package.json') as { version: string };
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const repositoryUrl = typeof rootPackageJson.repository === 'string'
	? rootPackageJson.repository
	: rootPackageJson.repository?.url ?? '';
const devTunnel = devTunnelName === undefined || devTunnelName === ''
	? false
	: ['1', 'true', 'quick'].includes(devTunnelName.toLowerCase())
		? true
		: {
			name: devTunnelName,
			autoStart: true,
		};

export default defineConfig({
	environments: {
		// 入力HTMLの追加はクライアント環境のみ（Workerビルドに波及させない）
		client: {
			build: {
				rollupOptions: {
					input: {
						index: resolve(__dirname, 'index.html'),
						embed: resolve(__dirname, 'embed.html'),
					},
				},
			},
		},
	},
	preview: {
		allowedHosts: [
			'.trycloudflare.com',
		],
	},
	server: {
		watch: {
			// .wrangler/state はMiniflareが頻繁に書き換えるため、HMRのトリガー対象から除外
			ignored: ['**/.wrangler/**'],
		},
		warmup: {
			clientFiles: [
				'./src/client/workers/archive-preview.worker.ts',
				'./src/client/workers/archive-download.worker.ts',
				'./src/client/workers/download-transform.worker.ts',
				'./src/client/workers/upload-worker.ts',
				'./src/client/workers/zip-extract.worker.ts',
			],
		},
	},
	optimizeDeps: {
		include: [
			'@pdfme/common',
			'@pdfme/generator',
			'@pdfme/schemas',
			'pako',
		],
	},
	resolve: {
		alias: {
			'@': resolve(__dirname, 'src/client'),
		},
	},
	define: {
		__VIEM_VERSION__: JSON.stringify(viemPackageJson.version),
		__REPOSITORY_URL__: JSON.stringify(repositoryUrl),
	},
	plugins: [
		cloudflare({
			configPath: wranglerConfigPath,
			tunnel: devTunnel as boolean,
		}),
		{
			name: 'generate-viem-chain-assets',
			buildStart() {
				execFileSync(pnpmCommand, ['generate:viem-chain-assets'], {
					cwd: __dirname,
					stdio: 'inherit',
				});
			},
		},
		vue(),
		VitePWA({
			strategies: 'injectManifest',
			srcDir: 'src/sw',
			filename: 'index.ts',
			injectRegister: 'auto',
			includeAssets: ['favicon.svg', 'favicon.ico'],
			manifest: {
				name: 'CFW FileUp',
				short_name: 'FileUp',
				description: 'Upload files to CFW FileUp.',
				lang: 'ja',
				start_url: '/my/buckets',
				scope: '/',
				display: 'standalone',
				background_color: '#f1f5f9',
				theme_color: '#4f46e5',
				icons: [
					{
						src: '/icon.any-192.png',
						sizes: '192x192',
						type: 'image/png',
						purpose: 'any',
					},
					{
						src: '/icon.any-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'any',
					},
					{
						src: '/icon.any-1200.png',
						sizes: '1200x1200',
						type: 'image/png',
						purpose: 'any',
					},
					{
						src: '/icon.maskable-192.png',
						sizes: '192x192',
						type: 'image/png',
						purpose: 'maskable',
					},
					{
						src: '/icon.maskable-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable',
					},
					{
						src: '/icon.maskable-1200.png',
						sizes: '1200x1200',
						type: 'image/png',
						purpose: 'maskable',
					},
				],
				share_target: {
					action: '/share-target',
					method: 'POST',
					enctype: 'multipart/form-data',
					params: {
						files: [
							{
								name: 'files',
								accept: ['*/*'],
							},
						],
					},
				},
			},
			devOptions: {
				enabled: true,
				type: 'module',
			},
			injectManifest: {
				globIgnores: ['assets/chains/**/*'],
			},
			workbox: {
				skipWaiting: true,
				clientsClaim: true,
			},
		}),
	],
});
