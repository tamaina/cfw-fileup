# File uploader with Cloudflare Workers (仮)
Cloudflare WorkersおよびR2を使用したファイルアップローダーのプロジェクト

## How to develop (Hono)
```bash
npm install
npm run dev
```

```bash
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```bash
npm run cf-typegen
```

Pass the `Env` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: Env }>()
```
