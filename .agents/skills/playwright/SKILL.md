---
name: playwright
description: "Playwrightのセットアップ、E2Eテスト実行、スクリーンショット撮影、GitHubへの添付まで一括解説。ローカル・クラウド両対応。"
context: fork
tags: [playwright, e2e, screenshot, github, gh, test]
---

## セットアップ

### バイナリとシステムライブラリ

`pnpm install` 時に `postinstall` が自動実行される:

```sh
# postinstall の動作（packages/app/package.json）
playwright install chromium --with-deps  # root環境（クラウド）では成功
# → 失敗した場合にフォールバック:
playwright install chromium              # バイナリのみ（非rootローカル）
```

非 root のローカル環境では、システムライブラリを初回のみ別途インストールする:

```sh
# PATH を引き継いで sudo 実行（Ubuntu / Debian）
sudo env PATH="$PATH" pnpm --filter app run playwright:install-deps

# または playwright バイナリを直接指定
sudo /path/to/repo/packages/app/node_modules/.bin/playwright install-deps chromium
```

### ブラウザの保存先

`PLAYWRIGHT_BROWSERS_PATH` 未設定時は `~/.cache/ms-playwright/` を使用。  
`playwright.config.ts` では環境変数を上書きしていないので、デフォルト動作に従う。

### 確認コマンド

```sh
pnpm --filter app run playwright:install        # バイナリ再取得（通常不要）
pnpm --filter app run playwright:install-deps   # システムライブラリ（要 sudo）
```

---

## E2Eテスト

### 実行コマンド

```sh
# 通常実行（開発サーバーは playwright が自動起動）
pnpm --filter app test:e2e

# クリーン実行（DBリセット → マイグレーション → テスト）
pnpm --filter app test:e2e:fresh

# UI モードでデバッグ
pnpm --filter app test:e2e:ui

# 特定テストのみ
pnpm --filter app test:e2e -- --grep "upload"
```

### テストの構成

- `packages/app/test/e2e/global-setup.ts` — `e2e_admin` / `e2e_password_123` でユーザー作成
- `packages/app/test/e2e/fixtures.ts` — `adminUser`・`loggedInPage` フィクスチャ
- `packages/app/test/e2e/auth.spec.ts` — サインイン・サインアップ UI テスト
- `packages/app/test/e2e/buckets.spec.ts` — バケット管理テスト

### 結果レポート

```sh
npx playwright show-report packages/app/playwright-report
```

失敗時のスクリーンショットは `packages/app/test-results/` に自動保存される。

---

## Playwright MCP によるブラウザ操作

`.mcp.json` に設定済みの `@playwright/mcp` を使うと、Claude が直接ブラウザを操作できる。
E2E テストスクリプトを書かずに、ページの確認・スクリーンショット撮影・UI 操作が可能。

### 主な使い方

- 開発サーバーを起動しておき、「`http://localhost:5173` を開いてスクリーンショットを撮って」と指示する
- ログインが必要なページは「メールアドレス X・パスワード Y でサインインして〇〇ページを確認して」のように伝える
- E2E テスト (`test:e2e`) が重い場面での簡易確認に向いている

### 注意点

- MCP 経由のブラウザ操作はヘッドレス Chromium で動く（画面には表示されない）
- 本格的な回帰テストは E2E テスト (`test:e2e`) を使うこと

---

## スクリーンショット撮影

### 撮影後の確認（エージェント向け）

撮影したPNGはReadツールで目視確認すること。以下の問題が写り込んでいる場合は、揉み消さずに原因を調べて対処する:

- **Vite HMR エラーオーバーレイ** (`Cannot read properties of null (reading 'invalidateTypeCache')`)  
  → `@vitejs/plugin-vue` のHMRバグ。worktreeでdev serverを起動した直後にファイル変更が検知されると発生することがある。`vite.config.ts` の `server.watch.ignored` に `.wrangler/**` を追加するなどで根本対処する。
- **コンポーネント読み込みエラー** (`Failed to fetch dynamically imported module`)  
  → Vueファイルのコンパイルエラー。featureブランチに未修正のバグが残っている可能性がある（例: `browse.vue` の `/    >` 構文エラー）。mainをマージして解消する。

### E2Eテスト内で撮影する

```typescript
await page.screenshot({ path: 'screenshots/result.png', fullPage: true });

// 特定要素だけ
await page.locator('.upload-list').screenshot({ path: 'screenshots/list.png' });
```

### スタンドアロンスクリプト（`packages/app/scripts/screenshot-pr.ts`）

開発サーバー起動済みの状態で、SCENARIO を指定して撮影する:

```sh
# dev サーバーを先に起動
pnpm --filter app dev &

# SCENARIO: auth | directory | upload | browse | passkeys | all
BASE_URL=http://localhost:5173 \
SCENARIO=directory \
SCREENSHOTS_DIR=/tmp/screenshots \
pnpm --filter app run screenshot
```

| SCENARIO | 撮影内容 |
|----------|---------|
| `auth` | signin・signup ページ |
| `directory` | バケット内ディレクトリ（テストデータ自動作成） |
| `upload` | アップロードページ |
| `browse` | ファイル閲覧ページ |
| `passkeys` | パスキー管理ページ |
| `all` | 上記すべて |

スクリプトは管理者アカウント（`e2e_admin` / `e2e_password_123`）でサインアップ・サインインを自動実行する。

### worktree で別ブランチをスクリーンショット

```sh
# ブランチを worktree に展開
git worktree add /tmp/pr-39 feature/grid-view
cd /tmp/pr-39 && pnpm install

# dev サーバー起動（バックグラウンド）
pnpm --filter app dev > /tmp/dev.log 2>&1 &
until curl -s http://localhost:5173 > /dev/null; do sleep 1; done

# スクリーンショット撮影（スクリプトはメインリポジトリのものを使用）
BASE_URL=http://localhost:5173 SCENARIO=directory SCREENSHOTS_DIR=/tmp/ss \
  pnpm --filter app run screenshot

# 後片付け
kill %1
git worktree remove /tmp/pr-39 --force
```

---

## GitHub Issue/PR への添付

`gh pr comment --attach` は現在のバージョンでは使用不可。  
**GitHub Release の公開アセット** を経由してURLを取得し、markdownに埋め込む。

### 重要な注意点

- `gh release upload "tag" "file.png#label"` の `#label` は**表示名（label）**であり、**ダウンロードURLには使われない**
  - ダウンロードURLは **ローカルのファイル名**（basename）が使われる
  - 例: `gh release upload "screenshots" "/tmp/ss/signin.png#pr23-signin.png"` → URL は `…/signin.png`（`pr23-signin.png` ではない）
- 複数PRを処理するときは、ローカルのファイル名にPR番号プレフィックスを付けてからアップロードする
- リリースはドラフトではなく**公開リリース**にする（ドラフトのURLは外部からアクセス不可）
- `gh` コマンドはgitリポジトリ内から実行すること（`/tmp` などgit管理外では失敗する）

```sh
# 1. 公開リリース作成（初回のみ）
gh release create "screenshots" --title "Screenshots" --notes ""
# すでにドラフトで作った場合は公開に変更
gh release edit "screenshots" --draft=false --latest=false

# 2. ファイル名に PR番号+Unix時刻 プレフィックスをつけてアップロード
#    （Unix時刻でCDNキャッシュを回避）
TS=$(date +%s)
cp /tmp/ss/signin.png /tmp/ss/pr23-${TS}-signin.png
gh release upload "screenshots" /tmp/ss/pr23-${TS}-signin.png --clobber
URL="https://github.com/tamaina/cfw-fileup/releases/download/screenshots/pr23-${TS}-signin.png"

# 3. PR コメントに埋め込む（リポジトリ内から実行すること）
gh pr comment 23 --body "![signin]($URL)"
```

### PR へのスクリーンショット投稿の一連の流れ（複数PR対応）

```sh
TS=$(date +%s)
SS_DIR=/tmp/ss-pr23-${TS}
mkdir -p "$SS_DIR"

# 1. worktree 作成 & install & migrate
git worktree add /tmp/wt-pr23-${TS} origin/feature/xxx
cd /tmp/wt-pr23-${TS}
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter app run db:reset
pnpm --filter app run db:migrate:local

# 2. dev サーバー起動
pnpm --filter app dev > /tmp/dev.log 2>&1 &
until curl -sf http://localhost:5173 > /dev/null; do sleep 2; done

# 3. 撮影（スクリプトはメインリポジトリのものを使用）
cd /path/to/main-repo
BASE_URL=http://localhost:5173 SCENARIO=directory SCREENSHOTS_DIR="$SS_DIR" \
  pnpm --filter app run screenshot

# 4. PR番号+Unix時刻プレフィックスをつけてリネーム → アップロード（リポジトリ内から実行）
cd /path/to/main-repo
for f in "${SS_DIR}"/*.png; do
  fname="pr23-${TS}-$(basename $f)"
  mv "$f" "${SS_DIR}/$fname"
  gh release upload "screenshots" "${SS_DIR}/$fname" --clobber
  URL="https://github.com/tamaina/cfw-fileup/releases/download/screenshots/$fname"
  gh pr comment 23 --body "![$(basename $f .png)]($URL)"
done

# 5. サーバー停止 & worktree削除
kill %1
git worktree remove /tmp/wt-pr23-${TS} --force
```

---

## 関連

- [testing スキル](../testing/SKILL.md) — テスト全体の概要
