# AGENTS.md

This file provides guidance to coding agents working on the `cfw-fileup` project. It covers the project structure, technology stacks, and important considerations for development.

Please see also [CHEATSHEET.md](CHEATSHEET.md) for common commands and troubleshooting tips.

## Project Overview

`cfw-fileup` is a file uploader service built on Cloudflare Workers, R2, and D1. It is a pnpm monorepo with two packages:

- `packages/app` — The main application: a Hono-based Worker backend + Vue 3 SPA frontend
  * `packages/app/src/worker` — Worker code (API routes, database access, etc.)
  * `packages/app/src/client` — Vue 3 SPA code (components, views, etc.)
  * `packages/app/src/shared` — Code shared between Worker and client (types, utilities, etc.)
- `packages/bgzf` — BGZF compression utilities

## pnpm/npm packages

### Ask DeepWiki
DeepWikiに問い合わせると、npmパッケージの内容理解に役立つ。

## We're using Git
何か作業で失敗したときは、Gitの差分を見たり復元したりすることもできる。

## Commands
Search .agents/skills

## Architecture

### Dual entrypoints via Vite + Cloudflare plugin

`packages/app/vite.config.ts` uses `@cloudflare/vite-plugin` alongside `@vitejs/plugin-vue`. This single Vite build produces both:
- The Cloudflare Worker (`src/worker/index.ts` → `wrangler.jsonc` `main`)
- The Vue 3 SPA client (`src/client/main.ts` → `index.html`)

The Worker serves the SPA's static assets and handles API routes.

### Backend (Hono)
Backend code is under `src/worker/`.

`src/worker/index.ts` is the Worker entrypoint.

#### Technology stacks

- Cloudflare Workers for serverless backend
- Hono for routing and middleware
- Drizzle ORM for database access (Cloudflare D1)
- Cloudflare R2 for file storage

#### Attention points

Cloudflare Workers や R2 は独特の制約や利用手段がある。

Workersは 10msの時間制限やメモリ制限がある。重たい作業は不可。ファイルを arrayBuffer関数 で メモリに展開せず、一部分を読む とか 直接渡しで処理する ことが重要。
R2はS3互換だがenv.R2から操作すべき。

#### Directory structure

- `worker/api` — API route handlers (関心ごとに分割)
- `worker/middleware` — Hono middleware (認証、ロギングなど)
- `worker/scheme` — Drizzle ORMスキーマ定義
- `worker/utils` — Worker内で使うユーティリティ関数

#### API
API routes are defined in `src/worker/index.ts` using Hono's routing. Each route handler is imported from `src/worker/api/`.

`worker/api/**/*.definition.ts` files contain OpenAPI like endpoint and schema definitions. It uses for documentation and type definition with SchemaType.

#### Database Schema

`src/worker/scheme/` contains Drizzle ORM table definitions.

**Important:** `createdAt` timestamps in `users` and `tokens` tables are derived from EAID-X IDs, not from `Date.now()`. This ensures consistency between the ID generation timestamp and the stored timestamp:

See `.claude/skills/eaid-x/SKILL.md` for details on EAID-X and how to parse it for timestamps.

#### Tests

```sh
# tsc型チェック
pnpm --filter app run typecheck:worker

# Vitest
pnpm --filter app run test:worker
```

### Shared code

`src/shared/` contains code used by both Worker and client.

### Client (Vue 3 SPA)

`src/client/` is a standard Vue 3 app. It has its own `tsconfig.json` scoped to the client files.

#### Technology stacks

- Vue 3 with Composition API
- Vite for bundling
- nirax は、Misskeyプロジェクトから持ち出してきたrouterライブラリ。router.definition.tsにルート定義あり。
- Vuetify 0 for UI

#### Tests

```sh
# vue-tsc型チェック
pnpm --filter app run typecheck:client
```

### Client Service Worker
`packages/app/src/sw/index.ts` is the entrypoint for the client-side Service Worker.  
Service Worker is used for decompression and re-compression for edge cases.

- tar.gz with BGZF: Re-compress because bsdtar (used in FreeBSD and macOS) doesn't support BGZF. So we need to re-compress it to normal gzip. See https://github.com/tamaina/cfw-fileup/issues/16
- Single files in tar.gz: Due to Miniflare's lack of streaming support, we need to decompress it in the Service Worker and serve it as a single file. See https://github.com/tamaina/cfw-fileup/issues/15

It is registered by vite-plugin-spa in vite.config.ts.

### TypeScript

All packages extend `tsconfig.base.json` at the root. Key settings: `strict`, `strictNullChecks`, `verbatimModuleSyntax`, `moduleResolution: Bundler`.

### ESLint

Uses `@misskey-dev/eslint-plugin` (recommended config) with `@typescript-eslint/parser`. Vue files use `eslint-plugin-vue`. Config is at `packages/app/eslint.config.js`.

## BGZF
BGZF は、このプロジェクトのモチベーションの一つで、tar.gz の中の1つのファイルをダウンロードするために使っている。  
BGZF や tar を作成するためのコードは `packages/bgzf` に書かれていru。
