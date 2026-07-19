# File uploader with Cloudflare Workers (仮)
Cloudflare WorkersおよびR2を使用したファイルアップローダーのプロジェクト

## Development
### Add `.dev.vars`
Add `packages/app/.dev.vars`. An example is available as `.dev.vars.example`.

You must add `PASSPHRASE` for first user signup.

### Install dependencies
```bash
pnpm install
```

## Local DB Migration
```bash
pnpm run --filter app db:migrate:local
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

## Worker secrets

Production/test Worker に公開するとき、次の値は `wrangler.jsonc` の `vars` ではなく Worker secret として設定します。

```bash
cd packages/app

pnpm wrangler secret put SIGNUP_PASSPHRASE
pnpm wrangler secret put TURNSTILE_SECRET
pnpm wrangler secret put GOOGLE_CLIENT_SECRET
pnpm wrangler secret put EVM_CHAIN_RPC_URLS
```

環境を分ける場合は `--env test` のように対象環境を付けます。

```bash
pnpm wrangler secret put EVM_CHAIN_RPC_URLS --env test
```

公開 repo に実デプロイ用の Worker/D1/R2 設定を置きたくない場合は、private repo に `wrangler.*.jsonc` を置いて `pnpm --filter app deploy:config <config>` でデプロイできます。詳しくは [docs/private-deploy-repo.md](docs/private-deploy-repo.md) を参照してください。

## Deploy with a private Wrangler config

実環境の Worker 名、D1 database ID、R2 bucket 名、公開 URL などを公開 repo に置きたくない場合は、別の private repo に `wrangler.*.jsonc` を置きます。

推奨配置:

```text
workspace/
  cfw-fileup/
  cfw-fileup-deploy/
    wrangler.test.jsonc
    wrangler.prod.jsonc
```

private config の `main` は、private config から見た app の Worker entrypoint を指します。

```jsonc
{
  "main": "../cfw-fileup/packages/app/src/worker/index.ts"
}
```

デプロイ:

```bash
cd cfw-fileup
pnpm install --frozen-lockfile
pnpm --filter app typecheck
pnpm --filter app deploy:config ../../../cfw-fileup-deploy/wrangler.test.jsonc cfw-fileup-db-test
```

`deploy:config` は同じ config を Vite build と Wrangler deploy の両方に渡します。第2引数に D1 database name を渡すと、deploy 前に remote migration も実行します。migration が不要な場合は省略できます。

```bash
pnpm --filter app deploy:config ../../../cfw-fileup-deploy/wrangler.test.jsonc
```
