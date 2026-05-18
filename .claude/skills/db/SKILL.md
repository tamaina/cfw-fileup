---
name: db
description: "Cloudflare D1 のマイグレーションとローカル運用に関するコマンド集。スキーマ変更やローカル検証時に役立ちます。"
tags: [d1, migrations, drizzle]
---

## 概要
`packages/app` の Drizzle スキーマ編集後のマイグレーション生成や D1 への適用手順を示します。

### マイグレーション番号の予約（重要）

マイグレーションを新規追加する前に、**必ず** GitHub Wiki で番号を予約してください。  
複数のPRが同じ番号を使うと衝突が発生します。

1. [DB Migration 予約一覧](https://github.com/tamaina/cfw-fileup/wiki/DB-Migration-%E4%BA%88%E7%B4%84%E4%B8%80%E8%A6%A7) を開く
2. 「次の予約可能番号」を確認し、自分のPR情報を予約一覧に追記して番号を+1する
3. スキーマを編集して `pnpm --filter app db:generate` を実行
4. 生成されたファイル名・`meta/_journal.json` の番号が予約した番号と一致しているか確認（ずれる場合は手動修正）

### コメントを残す
マイグレーションが生成されたら、生成されたsqlファイルの先頭にPRのURLを記載してください。

```sql
-- https://github.com/tamaina/cfw-fileup/pull/514
```

### マイグレーション操作
- マイグレーション生成: `pnpm --filter app db:generate` — `packages/app/src/worker/scheme/*.ts` を編集後に実行します。
- ローカル適用: `npx wrangler d1 migrations apply cfw-fileup-db --local`
- 本番適用: `npx wrangler d1 migrations apply cfw-fileup-db --remote`

### 補助コマンド
- マイグレーション一覧（ローカル）: `npx wrangler d1 migrations list cfw-fileup-db`
- SQL 実行（ローカル）: `npx wrangler d1 execute cfw-fileup-db --local --command "SELECT COUNT(*) FROM users"`
- ローカル D1 リセット: `rm -rf packages/app/.wrangler/state/v3/d1/`

### マイグレーションファイルのパス
`packages/app/migrations/*.sql`
