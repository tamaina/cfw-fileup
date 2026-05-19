---
name: eaid-x
description: "IDに利用しているEAID-Xはミリ秒の日付情報を持っています。データベースのプライマリキーに使います。EAID-Xを変換することでデータの作成時刻(createdAt)を得ることができます。"
tags: [id, date, typescript, db]
---

## EAID-X とは

`packages/app/src/shared/eaid-x.ts` で定義されたID形式。Misskey の AIDX をベースにしており、ミリ秒精度の作成日時をIDに埋め込んでいる。

フォーマット: `[9文字: 2000年1月1日からの経過ms (base36, 0→-)]-[4文字: ノードID]-[2文字: ノードID2] + [2文字カウンタ]`

例: `-ay3k2abc-xyz1-ab-1`

文字種は `-123456789abcdefghijklmnopqrstuvwxyz`（base36の0を`-`で置換）。

---

## 主要API

### `genEaidx(t: number): string`

現在時刻（Unixミリ秒）からIDを生成する。

```ts
import { genEaidx } from '@/shared/eaid-x';

const id = genEaidx(Date.now());
```

### `parseEaidx(id: string): { date: Date }`

IDから作成日時（`Date`オブジェクト）を取り出す。

```ts
import { parseEaidx } from '@/shared/eaid-x';

const { date } = parseEaidx(userId);
console.log(date.toISOString());
```

**DBへ `createdAt` を保存するときはこちらを使う（AGENTS.md の規約）:**

```ts
users.createdAt = parseEaidx(userId).date.getTime();
tokens.createdAt = parseEaidx(tokenId).date.getTime();
```

---

## 注意事項

- `createdAt` をDBに保存する際は `Date.now()` を使わず、IDから `parseEaidx(id).date` で取り出すこと（ID生成時刻との一貫性のため）。
- IDのbase36は **0を`-`に置換** しているため、パース時は逆変換（`replaceAll('-', '0')`）が必要。`parseEaidx` / `parseEaidxFull` がこれを処理済み。
