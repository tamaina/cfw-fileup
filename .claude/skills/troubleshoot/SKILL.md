---
name: troubleshoot
description: "よくあるトラブル（ポート競合、D1 エラー、node_modules 問題）の対処手順。開発中の障害対応に役立ちます。"
context: fork
tags: [troubleshoot, d1, port]
---

## よくあるトラブルと対処
- ポートが使用中:
  - プロセス終了: `pkill -9 -f "vite dev"`
  - 再起動: `pnpm --filter app dev`
- D1 データベースエラー:
  - ローカル再初期化: `rm -rf packages/app/.wrangler/state/v3/d1/`
  - マイグレーション再実行: `npx wrangler d1 migrations apply cfw-fileup-db --local`
- node_modules 問題:
  - 依存リビルド: `pnpm rebuild -r`
  - CIエラー…frozen-lockfileでpnpm install: `pnpm install --frozen-lockfile`
