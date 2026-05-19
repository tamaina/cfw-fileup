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

## 重要: package.json を編集したら必ず pnpm install を実行

`package.json` に依存パッケージを追加・削除・変更した場合、必ず `pnpm install` を実行して `pnpm-lock.yaml` を更新し、**両方をコミット**すること。

CIは `pnpm install --frozen-lockfile` を使うため、lockfile が package.json と一致していないと即座にCIが失敗する。
