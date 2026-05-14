# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`cfw-fileup` is a file uploader service built on Cloudflare Workers, R2, and D1. It is a pnpm monorepo with two packages:

- `packages/app` — The main application: a Hono-based Worker backend + Vue 3 SPA frontend
  * `packages/app/src/worker` — Worker code (API routes, database access, etc.)
  * `packages/app/src/client` — Vue 3 SPA code (components, views, etc.)
  * `packages/app/src/shared` — Code shared between Worker and client (types, utilities, etc.)
- `packages/bgzf` — Planned library for BGZF-format compression (for random-access into tar.gz files)

## pnpm/npm packages

### Workspaces
pnpm workspacesを使っています。cdを使わずとも、`--filter <package name>`で特定のパッケージに絞ってコマンドを実行します。

```
pnpm --filter app dev
```

### Ask DeepWiki
DeepWikiに問い合わせると、npmパッケージの内容を理解できます。活用してください。

## We're using Git
何か作業で失敗したときは、Gitの差分を見たり復元したりすることもできます。

## Commands
See CHEATSHEET.md

## Architecture

### Dual entrypoints via Vite + Cloudflare plugin

`packages/app/vite.config.ts` uses `@cloudflare/vite-plugin` alongside `@vitejs/plugin-vue`. This single Vite build produces both:
- The Cloudflare Worker (`src/worker/index.ts` → `wrangler.jsonc` `main`)
- The Vue 3 SPA client (`src/client/main.ts` → `index.html`)

The Worker serves the SPA's static assets and handles API routes.

### Worker (Hono)

`src/worker/index.ts` is the Worker entrypoint. Routes are defined with [Hono](https://hono.dev/). The Worker should be typed with `Env` from the generated `worker-configuration.d.ts`:

```ts
const app = new Hono<{ Bindings: Env }>()
```

#### Tests

```sh
# tsc型チェック
pnpm --filter app run typecheck:worker

# Vitest
pnpm --filter app run test:worker
```

#### Database (Drizzle ORM + D1)

Schema is defined under `src/worker/scheme/`. D1 is a Cloudflare SQLite binding; it must be configured in `wrangler.jsonc` before use.

### Shared code

`src/shared/` contains code used by both Worker and client.

### Client (Vue 3 SPA)

`src/client/` is a standard Vue 3 app. It has its own `tsconfig.json` scoped to the client files.

nirax は、Misskeyプロジェクトから持ち出してきたルーターです。router.definition.tsにルート定義があります。

#### Tests

```sh
# vue-tsc型チェック
pnpm --filter app run typecheck:client
```

### TypeScript

All packages extend `tsconfig.base.json` at the root. Key settings: `strict`, `strictNullChecks`, `verbatimModuleSyntax`, `moduleResolution: Bundler`.

### ESLint

Uses `@misskey-dev/eslint-plugin` (recommended config) with `@typescript-eslint/parser`. Vue files use `eslint-plugin-vue`. Config is at `packages/app/eslint.config.js`.
