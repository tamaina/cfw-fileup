---
name: api-definition
description: "worker/api/*.definition.ts の書き方と、SchemaType/ExtractRequestType/ExtractResponseTypeを使った型安全なAPI実装パターン。OpenAPIを分散して書いているので、apiの使い方は*.definition.tsを読むべき。"
tags: [api, typescript, hono, schema, openapi]
---

## 概要

`packages/app/src/worker/api/*.definition.ts` は、各APIエンドポイントのスキーマ定義ファイル。  
OpenAPI風の構造をTypeScriptの `as const satisfies Schema` で型付けし、ハンドラ側でリクエスト/レスポンス型を自動導出するために使う。

関連ファイル:
- `schema-type.ts` — `Schema` 型・`SchemaType` 型・`ExtractRequestType` / `ExtractResponseType` ユーティリティ・共有 `refs` の定義
- `openapi-generator.ts` — OpenAPIドキュメント生成。サーバーで`/api.json`で公開され、`/api-doc`にアクセスするとScalarによって人間が閲覧しやすい形で閲覧できる。

---

## definition.ts の構造

```ts
import type { Schema } from './schema-type';

export const fooApiSchema = [
  {
    path: '/api/foo/action',
    method: 'post',                    // 'get' | 'post' | 'put' | 'delete' | 'patch'
    summary: 'Do something',           // OpenAPI summary
    description: '詳細説明（省略可）',
    tags: ['Foo'],
    security: [{ bearerAuth: [] }],    // 認証が必要な場合のみ
    requestBody: {
      'application/json': {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          count: { type: 'number', nullable: true },
        },
        required: ['name', 'count'],
      } as const satisfies Schema,
    },
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
              required: ['id'],
            } as const satisfies Schema,
          },
        },
      },
      400: { description: 'Bad request' },  // bodyなしのエラーレスポンスはこれだけでOK
      401: { description: 'Unauthorized' },
    },
  },
] as const;  // ← 配列全体に as const が必要
```

### スキーマのルール

| フィールド | 型 | 備考 |
|---|---|---|
| `type` | `'string' \| 'number' \| 'integer' \| 'boolean' \| 'object' \| 'array' \| 'null'` | |
| `nullable` | `true` | nullを許容する場合 |
| `optional` | `true` | プロパティが省略可能な場合（requiredに含めない方法でも可） |
| `minLength` / `maxLength` | `number` | string用 |
| `minimum` / `maximum` | `number` | number用 |
| `items` | `Schema` | type='array'のとき |
| `properties` | `Record<string, Schema>` | type='object'のとき |
| `required` | `string[]` | 必須プロパティ名の配列 |
| `ref` | `keyof typeof refs` | 共有型への参照（後述） |

---

## ハンドラでの使い方

```ts
import { fooApiSchema } from './foo.definition';
import type { ExtractRequestType, ExtractResponseType } from './schema-type';

// リクエストボディの型
type CreateFooBody = ExtractRequestType<typeof fooApiSchema, '/api/foo/action', 'post'>;

// レスポンスの型（第4引数はHTTPステータスコード、省略時は200）
type CreateFooResponse = ExtractResponseType<typeof fooApiSchema, '/api/foo/action', 'post', 200>;

// 実際のハンドラ内での使用
app.post('/action', async (c) => {
  const body = (await c.req.json()) as ExtractRequestType<typeof fooApiSchema, '/api/foo/action', 'post'>;
  // body.name, body.count などが型安全に使える

  return c.json({ id: newId } as ExtractResponseType<typeof fooApiSchema, '/api/foo/action', 'post', 200>);
});
```

---

## 共有型（refs）

`schema-type.ts` の `refs` に定義された共有スキーマは `{ ref: 'RefName' }` で参照できる。

```ts
// schema-type.ts の refs に定義済みの型
// - OkResponse: { ok: boolean }
// - Bucket: { id, name, userId }
// - Quota: { maxBuckets, maxBucketSizeBytes, maxFilesPerBucket, maxDailyUploads }
// - AppSetting / AppSettings

// definition.ts での使い方
responses: {
  200: {
    description: 'Deleted',
    content: {
      'application/json': {
        schema: { ref: 'OkResponse' },
      },
    },
  },
},
```

新しい共有型が必要な場合は `schema-type.ts` の `refs` オブジェクトに追加する。

---

## 新しいエンドポイントを追加するときの手順

1. `*.definition.ts` にエンドポイントのスキーマを追加する
2. 対応する `*.ts` ハンドラに `app.post(...)` / `app.get(...)` を追加し、`ExtractRequestType` / `ExtractResponseType` で型を付ける
3. `index.ts` でルートがマウントされているか確認する（新ファイルの場合はマウントを追加）
