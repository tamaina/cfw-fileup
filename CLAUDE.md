# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`cfw-fileup` is a file uploader service built on Cloudflare Workers, R2, and D1. It is a pnpm monorepo with two packages:

- `packages/app` — The main application: a Hono-based Worker backend + Vue 3 SPA frontend
- `packages/bgzf` — Planned library for BGZF-format compression (for random-access into tar.gz files)

このプロジェクトは開発初期段階です。README.mdに書かれているタスクやエンドポイントを実装ていきます。実装が終わったらチェックボックスをオン(`[ ] → [x]`)にします。

## pnpm
pnpm workspacesを使っています。cdを使わずとも、`--filter <package name>`で特定のパッケージに絞ってコマンドを実行します。

```
pnpm --filter app dev
```

## Commands

All commands should be run from the repo root using pnpm:

```bash
pnpm dev       # Start local dev server (Vite + Cloudflare Workers runtime via @cloudflare/vite-plugin)
pnpm build     # Build for production
pnpm deploy    # Build and deploy to Cloudflare Workers via wrangler
```

From `packages/app` directly:
```bash
pnpm run cf-typegen   # Regenerate Cloudflare bindings types from wrangler.jsonc
```

Lint (from `packages/app`):
```bash
pnpm eslint .
```

There is no test suite configured yet.

## Architecture

### Dual entrypoints via Vite + Cloudflare plugin

`packages/app/vite.config.ts` uses `@cloudflare/vite-plugin` alongside `@vitejs/plugin-vue`. This single Vite build produces both:
- The Cloudflare Worker (`src/worker/index.ts` → `wrangler.jsonc` `main`)
- The Vue 3 SPA client (`src/client/main.ts` → `index.html`)

The Worker serves the SPA's static assets and handles API routes.

### Worker (Hono)

`src/worker/index.ts` is the Worker entrypoint. Routes are defined with [Hono](https://hono.dev/). The Worker should be typed with `CloudflareBindings` from the generated `worker-configuration.d.ts`:

```ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

### Database (Drizzle ORM + D1)

Schema is defined under `src/worker/scheme/`. Currently only `file.ts` exists (a `users` table placeholder). D1 is a Cloudflare SQLite binding; it must be configured in `wrangler.jsonc` before use.

### Shared code

`src/shared/` contains code used by both Worker and client.

### Client (Vue 3 SPA)

`src/client/` is a standard Vue 3 app. It has its own `tsconfig.json` scoped to the client files.

### TypeScript

All packages extend `tsconfig.base.json` at the root. Key settings: `strict`, `strictNullChecks`, `verbatimModuleSyntax`, `moduleResolution: Bundler`.

### ESLint

Uses `@misskey-dev/eslint-plugin` (recommended config) with `@typescript-eslint/parser`. Vue files use `eslint-plugin-vue`. Config is at `packages/app/eslint.config.js`.
