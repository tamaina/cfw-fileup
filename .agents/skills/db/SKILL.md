---
name: db
description: "Cloudflare D1 のマイグレーションとローカル運用に関するコマンド集。スキーマ変更やローカル検証時に役立ちます。"
tags: [d1, migrations, drizzle]
---

## 概要
`packages/app` の Drizzle スキーマ編集後のマイグレーション生成や D1 への適用手順を示します。

### コメントを残す
マイグレーションが生成されたら、生成されたsqlファイルの先頭にPRのURLを記載してください。

```sql
-- https://github.com/tamaina/cfw-fileup/pull/514
```

### マイグレーション操作
- マイグレーション生成: `pnpm run --filter app db:generate` — `packages/app/src/worker/scheme/*.ts` を編集後に実行します。
- ローカル適用: `pnpm run --filter app db:migrate:local`
- 本番適用: `npx wrangler d1 migrations apply cfw-fileup-db --remote`

### 補助コマンド
- マイグレーション一覧（ローカル）: `npx wrangler d1 migrations list cfw-fileup-db`
- SQL 実行（ローカル）: `npx wrangler d1 execute cfw-fileup-db --local --command "SELECT COUNT(*) FROM users"`
- ローカル D1 リセット: `rm -rf packages/app/.wrangler/state/v3/d1/`

### マイグレーションファイルのパス
`packages/app/migrations/*.sql`
