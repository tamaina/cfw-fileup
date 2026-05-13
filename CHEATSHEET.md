# cfw-fileup コマンドチートシート

## 開発環境

### 起動・停止

```bash
# Dev サーバー起動（Vite + Cloudflare Workers runtime）
pnpm --filter app dev

# ポート 5173 で起動（使用中なら 5174 など）
# アクセス: http://localhost:5173/

# サーバー停止
Ctrl+C
```

### ビルド・デプロイ

```bash
# ビルド（本番用）
pnpm --filter app build

# Cloudflare Workers にデプロイ
# 注意: wrangler.jsonc の database_id を設定する必要がある
pnpm --filter app deploy
```

## データベース管理

### マイグレーション

```bash
# 新しいスキーマ変更をマイグレーションファイルに生成
# src/worker/scheme/*.ts を編集してから実行
pnpm --filter app db:generate

# ローカル D1 に適用
npx wrangler d1 migrations apply cfw-fileup-db --local

# 本番 D1 に適用（デプロイ前）
npx wrangler d1 migrations apply cfw-fileup-db --remote
```

### D1 操作

```bash
# マイグレーション状態確認（ローカル）
npx wrangler d1 migrations list cfw-fileup-db

# SQL を直接実行（ローカル）
npx wrangler d1 execute cfw-fileup-db --local --command "SELECT COUNT(*) FROM users"

# ローカル D1 リセット（全データ削除）
rm -rf packages/app/.wrangler/state/v3/d1/
```

## コード品質

### Linting

```bash
# ESLint チェック
pnpm --filter app eslint src/worker/

# 自動修正
pnpm --filter app eslint src/worker/ --fix
```

### TypeScript チェック

```bash
# 型チェック
npx tsc --noEmit

# Worker コードのみ
npx tsc --noEmit src/worker/
```

## トラブルシューティング

### ポートが使用中

```bash
# 既存プロセスをすべて終了
pkill -9 -f "vite dev"

# その後、改めて起動
pnpm --filter app dev
```

### D1 データベースエラー

```bash
# ローカルデータベースを再初期化
rm -rf packages/app/.wrangler/state/v3/d1/

# マイグレーション再実行
npx wrangler d1 migrations apply cfw-fileup-db --local
```

### Node modules の問題

```bash
# 依存関係を再インストール
rm -rf node_modules packages/*/node_modules
pnpm install
```

## 環境変数

`packages/app/wrangler.jsonc` の `vars` セクションで設定：
（現在は DB ベースの管理に移行しているため、以下は参考のみ）

```jsonc
"vars": {
  "SIGNUP_PASSPHRASE": "",          // サインアップ時の認証パスフレーズ
  "MAX_BUCKETS_PER_USER": "",       // （廃止）ユーザーあたりのバケット数
  "MAX_BUCKET_SIZE_BYTES": "",      // （廃止）バケットの最大容量
  "MAX_FILES_PER_BUCKET": "",       // （廃止）バケット内のファイル数
  "MAX_DAILY_UPLOADS": ""           // （廃止）日当たりのアップロード数
}
```

**注:** レート制限は `/api/admin/set-user-quota` と `/api/admin/set-global-quota` で管理します。

## pnpm フィルター

packages 内の特定パッケージでのみコマンド実行：

```bash
# app パッケージのみ
pnpm --filter app <command>

# bgzf パッケージのみ
pnpm --filter bgzf <command>

# すべての packages
pnpm --filter "{packages/*}" <command>
```

例：
```bash
pnpm --filter app dev
pnpm --filter app build
pnpm --filter app db:generate
pnpm --filter app eslint src/
```
