---
name: deploy
description: "本番ビルドと Cloudflare Workers へのデプロイ手順。デプロイ前の注意点（wrangler.jsonc の設定など）を含みます。"
context: fork
tags: [build, deploy, wrangler]
---

## 概要
本番ビルドとデプロイ方法について。`packages/app` に対して実行します。

### 主なコマンド
- ビルド（本番）: `pnpm --filter app build`
- デプロイ: `pnpm --filter app deploy` — `wrangler.jsonc` の `vars` や `database_id` を確認してください。

### 注意
- `wrangler.jsonc` の `database_id` や環境変数を正しく設定してからデプロイを行ってください。

**今のところ、本番環境での運用はしていないので、デプロイをしないこと！**
