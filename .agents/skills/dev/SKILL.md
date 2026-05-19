---
name: dev
description: "ローカル開発の起動・停止、開発サーバーの使用方法。新しい開発者がローカルで作業を始めるときに役立ちます。"
context: fork
tags: [dev, vite, worker]
---

## 概要
`packages/app` の開発サーバー起動、停止、注意点をまとめます。

### 主なコマンド
- 開発サーバー起動: `pnpm --filter app dev` — Vite + Cloudflare Workers runtime で起動します（デフォルトポート: 5173）。
- サーバー停止: `Ctrl+C`

### 使い方メモ
- ポート衝突時は別ポート（例: 5174）で起動してください。
- 大きな変更を加えた場合は再ビルドが必要になることがあります。