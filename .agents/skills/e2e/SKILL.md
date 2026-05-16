---
name: e2e
description: "Playwright を使った E2E テストの実行方法とテスト構成。CI やローカルでの総合確認に便利です。"
context: fork
tags: [playwright, e2e, test]
---

## 概要
`packages/app/test/e2e` にある E2E テストの実行と推奨ワークフローをまとめます。

### 主なコマンド
- クリーン実行（DBリセット→マイグレーション→テスト）: `pnpm --filter app test:e2e:fresh`
- 通常実行: `pnpm --filter app test:e2e`
- UI モード: `pnpm --filter app test:e2e:ui`
- デバッグ: `pnpm --filter app test:e2e:debug`

### 補足
- `global-setup` がテスト用 admin ユーザーを作成します（`e2e_admin` / `e2e_password_123`）。
- HTML レポート: `npx playwright show-report packages/app/playwright-report`
