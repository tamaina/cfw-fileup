# Private Deploy Repository

実デプロイ用の `wrangler` config は、公開 repo ではなく private repo に置く運用にできます。

## Repository layout

```text
cfw-fileup-deploy/
  wrangler.test.jsonc
  wrangler.prod.jsonc
  README.md
```

`wrangler.*.jsonc` には Worker 名、D1 database ID、R2 bucket 名、公開 URL など、公開 repo に置きたくない構成情報を書きます。

secret 値は private repo にも commit せず、Cloudflare Workers secrets に入れます。

## Example deploy config

```jsonc
{
  "$schema": "../cfw-fileup/packages/app/node_modules/wrangler/config-schema.json",
  "name": "cfw-fileup-test",
  "main": "../cfw-fileup/packages/app/src/worker/index.ts",
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": [
      "/api/*",
      "/api.json",
      "/api-doc",
      "/upload/*",
      "/v/*",
      "/d/*",
      "/e/*",
      "/a/*",
      "/ping",
      "/id"
    ]
  },
  "compatibility_date": "2026-05-11",
  "vars": {
    "TURNSTILE_SITE_KEY": "",
    "GOOGLE_CLIENT_ID": "",
    "GOOGLE_REDIRECT_URI": "",
    "MAIL_FROM": "",
    "PUBLIC_APP_URL": "https://cfw-fileup-test.example.workers.dev"
  },
  "send_email": [
    {
      "name": "MAILER"
    }
  ],
  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "cfw-fileup-storage-test"
    }
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "cfw-fileup-db-test",
      "database_id": "00000000-0000-0000-0000-000000000000"
    }
  ]
}
```

## Deploy

private repo と public repo を同じ親ディレクトリに置いた例です。

```bash
git clone https://github.com/tamaina/cfw-fileup.git
git clone git@github.com:tamaina/cfw-fileup-deploy.git

cd cfw-fileup
pnpm install --frozen-lockfile
pnpm --filter app typecheck
pnpm --filter app deploy:config -- ../../../cfw-fileup-deploy/wrangler.test.jsonc cfw-fileup-db-test
```

`deploy:config` は指定した config で production build、D1 migration、Worker deploy を順に実行します。D1 migration を実行しない場合は database name を省略できます。
内部では `CF_WRANGLER_CONFIG_PATH` を使って Vite build にも同じ config を渡すため、build が生成する deploy config と Wrangler deploy の参照先が揃います。
`main` は private repo の config から見た相対パスで指定します。

```bash
pnpm --filter app deploy:config -- ../../../cfw-fileup-deploy/wrangler.test.jsonc
```

## Secrets

```bash
cd cfw-fileup/packages/app

pnpm wrangler secret put SIGNUP_PASSPHRASE --config ../../../cfw-fileup-deploy/wrangler.test.jsonc
pnpm wrangler secret put TURNSTILE_SECRET --config ../../../cfw-fileup-deploy/wrangler.test.jsonc
pnpm wrangler secret put GOOGLE_CLIENT_SECRET --config ../../../cfw-fileup-deploy/wrangler.test.jsonc
pnpm wrangler secret put EVM_CHAIN_RPC_URLS --config ../../../cfw-fileup-deploy/wrangler.test.jsonc
```
