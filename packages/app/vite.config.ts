import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/client'),
    },
  },
  plugins: [
    cloudflare({
      configPath: "./wrangler.jsonc",
    }),
    vue()
  ],
});
