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

## スクリーンショット撮影

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
**GitHub Release のドラフトアセット** を経由してURLを取得し、markdownに埋め込む:

```sh
# 1. ドラフトリリース作成（初回のみ）
gh release create "screenshots" --title "Screenshots" --notes "" --draft

# 2. 画像をアップロードしてURLを取得
FILENAME="my-shot-$(date +%s).png"
gh release upload "screenshots" "/tmp/ss/result.png#$FILENAME" --clobber
TAG=$(gh release view "screenshots" --json tagName -q .tagName)
URL="https://github.com/tamaina/cfw-fileup/releases/download/$TAG/$FILENAME"

# 3. PR コメントに埋め込む
gh pr comment <PR_NUMBER> --body "![screenshot]($URL)"
```

### PR へのスクリーンショット投稿の一連の流れ

```sh
# 1. dev サーバー起動
pnpm --filter app dev > /tmp/dev.log 2>&1 &
until curl -s http://localhost:5173 > /dev/null; do sleep 2; done

# 2. DBマイグレーション（ワークツリーの場合）
pnpm --filter app run db:migrate:local

# 3. 撮影
BASE_URL=http://localhost:5173 SCENARIO=directory SCREENSHOTS_DIR=/tmp/ss \
  pnpm --filter app run screenshot

# 4. GitHub Release にアップロードして URL 取得
TAG=$(gh release view "screenshots" --json tagName -q .tagName)
for f in /tmp/ss/*.png; do
  name="$(basename $f .png)-$(date +%s%3N).png"
  gh release upload "screenshots" "$f#$name" --clobber 2>/dev/null
  URL="https://github.com/tamaina/cfw-fileup/releases/download/$TAG/$name"
  gh pr comment <PR_NUMBER> --body "![$(basename $f .png)]($URL)"
done

# 5. サーバー停止
kill %1
```

---

## 関連

- [testing スキル](../testing/SKILL.md) — テスト全体の概要
