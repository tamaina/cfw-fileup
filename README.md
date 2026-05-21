# File uploader with Cloudflare Workers (仮)
Cloudflare WorkersおよびR2を使用したファイルアップローダーのプロジェクト

## Install dependencies
```bash
pnpm install
```

## Start dev server
```bash
pnpm run --filter app dev
```

With quick tunnel

```bash
CF_DEV_TUNNEL=quick pnpm run dev
```

You can access the app at `*.trycloudflare.com` (url will be printed in vite log after the server starts)

## Google OAuth

Google Cloud Console で OAuth クライアント ID を作るときは、承認済みのリダイレクト URI に次を設定します。

```text
https://<app-origin>/api/auth/google/callback
```

例:

```text
http://localhost:5173/api/auth/google/callback
https://example.com/api/auth/google/callback
https://<quick-tunnel>.trycloudflare.com/api/auth/google/callback
```

`GOOGLE_REDIRECT_URI` を設定していない場合、アプリはリクエスト元の origin から callback URL を自動生成します。Google 側に登録した URI と一致させたい場合は、`packages/app/.dev.vars` などで明示します。

```env
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://<app-origin>/api/auth/google/callback
```

`GOOGLE_CLIENT_ID` は secret ではないので `packages/app/wrangler.jsonc` の `vars` に設定できます。quick tunnel は起動ごとに URL が変わるため、Google OAuth クライアントのリダイレクト URI もその URL に合わせて更新してください。固定したい場合は named tunnel など安定した HTTPS origin を使います。

## Local DB Migration
```bash
pnpm run --filter app db:migrate:local
```
