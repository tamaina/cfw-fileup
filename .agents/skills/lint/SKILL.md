---
name: lint
description: "ESLint と TypeScript 型チェックの実行コマンド。コード品質チェックや自動修正に使います。"
context: fork
tags: [eslint, typescript, lint]
---

## 概要
コード品質に関わるコマンドをまとめます。

### 主なコマンド
- ESLint チェック: `pnpm --filter app eslint src/worker/`
- 自動修正: `pnpm --filter app eslint src/worker/ --fix`
- TypeScript 型チェック（全体）: `npx tsc --noEmit`
- Worker のみ型チェック: `npx tsc --noEmit src/worker/`
