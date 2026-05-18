---
name: wiki-migration
description: "GitHub WikiのDBマイグレーション予約一覧を更新する手順。オープンPRの状態を反映してDB-Migration-予約一覧.mdを最新に保つ。"
---

# DB Migration Wiki 更新手順

## Wiki リポジトリの操作

```bash
# クローン（未クローンの場合）
TOKEN=$(gh auth token)
git clone https://tamaina:${TOKEN}@github.com/tamaina/cfw-fileup.wiki.git /tmp/cfw-fileup.wiki

# 既にクローン済みの場合はpull
cd /tmp/cfw-fileup.wiki && git pull
```

## 更新ロジック

### 1. developの最新マイグレーション番号を取得

```bash
ls packages/app/migrations/*.sql | grep -v meta | sort | tail -1
```

最大番号（例: `0011_used_names.sql` → `0011`）を記録する。

### 2. オープンPRのマイグレーションファイルを一覧

```bash
gh pr list --state open --json number,title,headRefName | jq -r '.[].number' | while read pr; do
  files=$(gh pr diff $pr --name-only 2>/dev/null | grep "migrations/[0-9]" | grep -v meta)
  if [ -n "$files" ]; then
    echo "PR #$pr: $files"
  fi
done
```

### 3. Wiki ページを更新

`/tmp/cfw-fileup.wiki/DB-Migration-予約一覧.md` を編集する。

更新内容:
- **developの最新マイグレーション番号**: 手順1で得た番号
- **次の予約可能番号**: 現在予約中の最大番号 + 1（マージ済みPRは除く）
- **予約一覧**: オープンPRが持つマイグレーションを列挙
  - クローズ・マージ済みPRのエントリは削除
  - 新たに追加されたマイグレーションは追記
  - developにすでに存在する番号は ✅ マージ済み として削除

### 4. コミット・プッシュ

```bash
cd /tmp/cfw-fileup.wiki
git config user.email "tamaina@hotmail.co.jp"
git config user.name "tamaina"
git add DB-Migration-予約一覧.md
git diff --cached --quiet || git commit -m "chore: update migration reservation list"
TOKEN=$(gh auth token)
git remote set-url origin https://tamaina:${TOKEN}@github.com/tamaina/cfw-fileup.wiki.git
git push
```

## 注意

- 「次の予約可能番号」はオープンPRが予約している番号のうち最大のもの + 1
- PRがマージ済みになっていても、developに反映されるまでタイムラグがある場合は予約中のままにしておく
- 衝突（同一番号を複数PRが持つ）は ⚠️ 要リナンバー と記載し、関係するPRにコメントで通知する
