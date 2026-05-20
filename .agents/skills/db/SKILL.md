---
name: db
description: "Cloudflare D1, Drizzle のマイグレーションとローカル運用に関するコマンド集。スキーマ変更やローカル検証時に読みます。"
tags: [d1, migrations, drizzle, db, schema, scheme]
---

## 概要
`packages/app` の Drizzle スキーマ編集後のマイグレーション生成や D1 への適用手順を示します。

### コメントを残す
マイグレーションが生成されたら、生成されたsqlファイルの先頭にPRのURLを記載してください。

```sql
-- https://github.com/tamaina/cfw-fileup/pull/514
```

## マイグレーション

### マイグレーション生成
`packages/app/src/worker/scheme/*.ts` を編集後に次のコマンドを実行します。

**絶対に、自分でsqlファイルを生成しないように！！**

```bash
`pnpm run --filter app db:generate
```

### マイグレーション/初期導入実行

- ローカル環境: `pnpm run --filter app db:migrate:local`
- 本番適用: `pnpm --filter app exec wrangler d1 migrations apply cfw-fileup-db --remote`

### 補助コマンド
- マイグレーション一覧（ローカル）: `pnpm --filter app exec wrangler d1 migrations list cfw-fileup-db`
- SQL 実行（ローカル）: `pnpm --filter app exec wrangler d1 execute cfw-fileup-db --local --command "SELECT COUNT(*) FROM users"`
- ローカル D1 リセット: `packages/app/.wrangler/state/v3/d1/` 以下のファイルを削除

### マイグレーションファイルのパス
`packages/app/migrations/*.sql`

## テストヘルパー

Worker テストの DB 初期化は `packages/app/test/worker/helpers.ts` で行っています。

- 生成された migration SQL は `?raw` 付きで import し、`migrations` 配列へ実行順に追加してください。
- `setupDb()` は `migrations` 配列の SQL を `--> statement-breakpoint` で分割して適用します。本番/ローカル D1 と同じ migration SQL を使うため、テスト用に別 SQL を手書きしないでください。
- 新しいテーブルを追加した場合は、`tables` 配列と `clearDb()` の削除順も更新してください。外部キーがあるので、依存する子テーブルから先に削除します。
- migration を作り直したりファイル名が変わった場合は、古い import と `migrations` 配列の参照も忘れずに置き換えてください。
