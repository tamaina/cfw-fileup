---
name: testing
description: "プロジェクト内のテスト一覧と概要。どのテストが何をカバーしているかを把握するのに使います。"
context: fork
tags: [test, vitest, playwright, e2e]
---

## テストの種類

このプロジェクトには4種類のテストがあります。

| 種類 | ツール | 対象 | コマンド |
|------|--------|------|---------|
| Worker ユニット/インテグレーション | Vitest | `packages/app/test/worker/` | `pnpm --filter app test:worker` |
| 共有コード ユニット | Vitest | `packages/app/test/eaid-x.test.ts` | `pnpm --filter app test` |
| BGZF ユニット | Vitest | `packages/bgzf/test/index.test.ts` | `pnpm --filter bgzf test` |
| E2E | Playwright | `packages/app/test/e2e/` | `pnpm --filter app test:e2e` |

型チェックもテストの一環として使います（→ [lint スキル](../lint/SKILL.md)）。

---

## Worker テスト （Vitest）

`packages/app/test/worker/` 配下に API エンドポイントのインテグレーションテストがあります。  
`helpers.ts` にアプリインスタンス・DB セットアップ・共通ヘルパーがまとめられています。

### 実行コマンド

```sh
# 全 Worker テスト
pnpm --filter app test:worker

# ウォッチモード
pnpm --filter app test:worker:watch
```

---

## 共有コードテスト （Vitest）

`packages/app/test/eaid-x.test.ts` — EAID-X ID の生成・パース・バリデーション関数のユニットテスト。  
→ EAID-X の詳細は [eaid-x スキル](../eaid-x/SKILL.md) を参照。

```sh
# eaid-x テストを含む全 Vitest テスト
pnpm --filter app test
```

---

## BGZF テスト （Vitest）

`packages/bgzf/test/index.test.ts` — `packages/bgzf` のユニットテスト。テスト環境は `node`。

### 実行コマンド

```sh
# 全 bgzf テスト
pnpm --filter bgzf test

# ウォッチモード
pnpm --filter bgzf test:watch
```

### テスト構成（describe ブロック）

- **`createBgzfBlock`** — BGZF ブロックのヘッダフィールド・CRC32・ISIZE・ラウンドトリップ・サイズ上限を検証
- **`TarArchiver`** — `FileSystemDirectoryHandle` をモックし、tar ストリームの内容とインデックス（オフセット・サイズ）を検証
- **`BgzfTarArchiver`** — BGZF 圧縮 tar のブロック構造・ラウンドトリップ・インデックスのブロック境界情報を検証

---

## E2E テスト （Playwright）

`packages/app/test/e2e/` 配下にブラウザ操作を使った総合テストがあります。

→ 実行方法の詳細は [e2e スキル](../e2e/SKILL.md) を参照。

---

## 型チェック

テストではありませんが、型チェックも品質確認の一環です。

```sh
pnpm --filter app typecheck           # 全体
pnpm --filter app typecheck:worker    # Worker のみ
pnpm --filter app typecheck:client    # Vue クライアントのみ
pnpm --filter app typecheck:sw        # Service Worker のみ
```

→ ESLint・型チェックのコマンド詳細は [lint スキル](../lint/SKILL.md) を参照。
