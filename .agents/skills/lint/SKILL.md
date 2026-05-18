---
name: lint
description: "ESLint と TypeScript 型チェックの実行コマンド。コード品質チェックや自動修正に使います。"
context: fork
tags: [eslint, typescript, lint]
---

## 概要
コード品質に関わるコマンドをまとめます。

### ESLint
`eslint` スクリプトは `src/worker/` を対象にしています。

- ESLint チェック: `pnpm --filter app run eslint`
- 自動修正: `pnpm --filter app run eslint:fix`

### TypeScript 型チェック
スコープごとにスクリプトが分かれています。

- 全体: `pnpm --filter app run typecheck`
- Worker のみ: `pnpm --filter app run typecheck:worker`
- Client のみ: `pnpm --filter app run typecheck:client`
- Service Worker のみ: `pnpm --filter app run typecheck:sw`
