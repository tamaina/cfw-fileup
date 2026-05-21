import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

const devTunnelName = process.env.CF_DEV_TUNNEL;
const devTunnel = devTunnelName === undefined || devTunnelName === ''
  ? false
  : ['1', 'true', 'quick'].includes(devTunnelName.toLowerCase())
    ? true
    : {
      name: devTunnelName,
      autoStart: true
    };

export default defineConfig({
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
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/client'),
    },
  },
  plugins: [
    cloudflare({
      configPath: "./wrangler.jsonc",
      tunnel: devTunnel as boolean,
    }),
    vue(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'index.ts',
      injectRegister: 'auto',
      devOptions: {
        enabled: true,
        type: 'module',
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
      }
    }),
  ],
});
