---
name: screenshot-github
description: "Playwrightでスクリーンショットを撮影し、GitHubのIssue/PRの説明やコメントに添付する手順。UIの動作確認結果をGitHubに記録したいときに使います。"
context: fork
tags: [playwright, screenshot, github, gh]
---

## 1. Playwrightでスクリーンショットを撮る

### E2Eテスト内で撮影する

```typescript
// test 内で page.screenshot() を呼ぶ
await page.screenshot({ path: 'screenshots/result.png' });

// 特定要素だけ
const el = page.locator('.upload-list');
await el.screenshot({ path: 'screenshots/upload-list.png' });

// フルページ
await page.screenshot({ path: 'screenshots/full.png', fullPage: true });
```

テスト失敗時は `playwright.config.ts` の `screenshot: 'only-on-failure'` により自動保存される。  
保存先: `packages/app/test-results/`

### スタンドアロンスクリプトで撮影する

E2Eテストを起動せず、単発でスクリーンショットだけ撮りたい場合:

```typescript
// scripts/screenshot.ts
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  executablePath: process.env['PLAYWRIGHT_BROWSERS_PATH']
    ? `${process.env['PLAYWRIGHT_BROWSERS_PATH']}/chromium-*/chrome-linux/chrome`
    : undefined,
});
const page = await browser.newPage();
await page.goto('http://localhost:5173');

// ログインが必要な場合
await page.evaluate((token) => {
  localStorage.setItem('cfw_fileup_token', token);
}, process.env['E2E_TOKEN'] ?? '');
await page.reload();
await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 10_000 });

await page.screenshot({ path: 'screenshots/demo.png', fullPage: true });
await browser.close();
```

```sh
# 実行 (開発サーバーを先に起動しておく)
pnpm --filter app dev &
npx tsx scripts/screenshot.ts
```

---

## 2. GitHubのIssue/PRへ添付する

GitHub CLIの `gh` コマンドを使います。  
画像はGitHubのアップロードAPIを経由して添付します。

### 方法A: `gh issue comment` / `gh pr comment` に本文を直接書く

画像をGitHubへアップロードする方法として、現状サポートされているのは以下のアプローチです。

#### `--attach` オプション（gh v2.48+）

```sh
# Issue にコメントを付けてスクリーンショットを添付
gh issue comment <ISSUE_NUMBER> \
  --body "スクリーンショットです" \
  --attach screenshots/result.png

# PR にコメント
gh pr comment <PR_NUMBER> \
  --body "動作確認の結果です" \
  --attach screenshots/result.png

# 複数ファイル
gh pr comment <PR_NUMBER> \
  --body "ビフォー/アフター" \
  --attach screenshots/before.png \
  --attach screenshots/after.png
```

> **注意**: `--attach` は `gh` v2.48 以降が必要。`gh --version` で確認。

#### `gh` のバージョンが古い場合: GitHubのAPIで手動アップロード

```sh
# 1. ファイルをbase64エンコードしてGitHubのメディアAPIでアップロード
#    (公式にはサポート外だが動作する undocumented endpoint)
OWNER=tamaina
REPO=cfw-fileup
FILE=screenshots/result.png
FILENAME=$(basename "$FILE")

# GitHub アップロードポリシーを取得
POLICY=$(curl -s \
  -H "Authorization: Bearer $(gh auth token)" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$FILENAME\", \"size\": $(wc -c < "$FILE"), \"content_type\": \"image/png\"}" \
  "https://github.com/$OWNER/$REPO/upload/policies/assets")

# アップロード先URLとフォームフィールドを使って PUT
UPLOAD_URL=$(echo "$POLICY" | jq -r '.upload_url')
ASSET_URL=$(echo "$POLICY" | jq -r '.asset.href')

# S3互換アップロード (フォームフィールドは policy.form に含まれる)
curl -s \
  $(echo "$POLICY" | jq -r '.form | to_entries | map("-F \(.key)=\(.value)") | join(" ")') \
  -F "file=@$FILE" \
  "$UPLOAD_URL"

echo "画像URL: $ASSET_URL"

# 2. 取得した URL をコメント本文に埋め込む
gh issue comment <ISSUE_NUMBER> --body "![screenshot]($ASSET_URL)"
```

### 方法B: Gistを経由する（シンプル）

```sh
# Gist に画像をアップロード → raw URLをコメントに使う
GIST_URL=$(gh gist create --public screenshots/result.png --desc "screenshot" | tail -1)
RAW_URL="${GIST_URL/gist.github.com/gist.githubusercontent.com}/raw/result.png"
gh pr comment <PR_NUMBER> --body "![screenshot]($RAW_URL)"
```

> Gist raw URLは形式が変わることがあるため、信頼性はやや低い。

### 方法C: PRのdescriptionに画像を含める

```sh
# PR本文を更新（既存の本文に画像を追記）
CURRENT=$(gh pr view <PR_NUMBER> --json body -q .body)
gh pr edit <PR_NUMBER> --body "$CURRENT

---
## スクリーンショット
![result](https://github.com/$OWNER/$REPO/assets/...アップロード後のURL...)"
```

---

## 3. よく使う組み合わせパターン

### E2Eテスト結果をPRコメントに貼る（CI向け）

```sh
# E2Eテスト実行（失敗時はtest-results/に自動保存）
pnpm --filter app test:e2e || true

# 失敗スクリーンショットがあればPRにコメント
SCREENSHOTS=$(find packages/app/test-results -name '*.png' 2>/dev/null)
if [ -n "$SCREENSHOTS" ]; then
  ATTACH_FLAGS=""
  for f in $SCREENSHOTS; do
    ATTACH_FLAGS="$ATTACH_FLAGS --attach $f"
  done
  gh pr comment "$PR_NUMBER" --body "E2Eテストで失敗したスクリーンショット:" $ATTACH_FLAGS
fi
```

### UI確認後にIssueへ記録する

```sh
# 開発サーバー起動済みの状態で
pnpm --filter app test:e2e -- --grep "upload"   # 対象テストのみ実行
# test-results/ に出力された png を添付
gh issue comment <ISSUE_NUMBER> \
  --body "動作確認完了。スクリーンショット添付。" \
  --attach packages/app/test-results/**/*.png
```

---

## 関連

- [e2e スキル](../e2e/SKILL.md) — E2Eテストの実行方法
- [testing スキル](../testing/SKILL.md) — テスト全体の概要
