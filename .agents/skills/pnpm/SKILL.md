---
name: pnpm
description: "pnpm のフィルターオプションを使ったパッケージ単位コマンド実行。特定パッケージのみ操作したいときに便利です。"
context: fork
tags: [pnpm, workspace]
---

## 概要
pnpm の `--filter` を使うと、特定パッケージのみコマンドを実行できます。

### 例
- `pnpm --filter app dev`
- `pnpm --filter app build`
- `pnpm --filter app db:generate`
- `pnpm --filter bgzf test`
- 複数パッケージ: `pnpm --filter "{packages/*}" <command>`

### 補助
- ワークスペースで一括実行: `pnpm -w -r <script>`
