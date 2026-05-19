---
name: api
description: "APIのプロトコルとソースの場所。"
tags: [api, typescript, hono, schema, openapi]
---

## 概要

- `packages/app/src/shared/api.schemas.ts` - 共有エラーレスポンススキーマ
- `packages/app/src/shared/api/index.ts` - APIスキーマ定義ファイルのインデックス
- `packages/app/src/shared/api/*.ts` - APIスキーマ定義ファイル
- `packages/app/src/worker/api/*.ts` - API実装ファイル ハンドラ

## プロトコル
- エンドポイントは`/api/`以下。
- apiリクエストはなんでもかんでも`application/json`をbodyにした`POST`にしたい  
  ただ、次のような場面ではGETにする。性質上、要求はクエリ文字列にする
  * 全ユーザーに対してキャッシュを効かせられる
    * 短期間 - `/api/meta`
    * 長期間
    * etagを利用

---

## 共有スキーマ `shared/api.schemas.ts`

全エラーレスポンスで使う共通スキーマ：

```ts
import * as v from 'valibot';

export const ErrorResponse = v.pipe(
  v.object({ error: v.string() }),
  v.metadata({ ref: 'ErrorResponse' }),
);
```

---

## 定義ファイル `shared/api/*.ts`

```ts
import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.types.js';
import { ErrorResponse } from '../api.schemas.js';

// OpenAPI ref ... 複数のAPIでスキーマを共有する場合
const UserResponse = v.pipe(
  v.object({
    id: v.string(),
    username: v.string(),
    isAdmin: v.boolean(),
  }),
  v.metadata({ ref: 'User' }),
);

export const exampleApiDef = {
  '/api/users/show': {
    summary: 'Get account info from user id',
    tags: ['users'],
    req: v.object({
      userId: v.string(),
    }),
    // 【重要】全ての応答コードに description と content + vSchema を設定すること。
    // describeResponse の型推論は vSchema から T を組み立てるため、
    // content が欠けているエントリがあると T の推論が壊れ連鎖型エラーになる。
    // エラー応答は onError が { error: string } を返すので ErrorResponse を使う。
    res: {
      200: { description: 'Success', content: { 'application/json': { vSchema: UserResponse } } },
      404: { description: 'Not Found', content: { 'application/json': { vSchema: ErrorResponse } } },
      401: { description: 'Unauthorized', content: { 'application/json': { vSchema: ErrorResponse } } },
    },
  },
} as const satisfies ApiEndpointDefinitionRecord;
```

## インデックスファイル `shared/api/index.ts`
新しいAPIファイルを作成する場合は、`index.ts` の `apiDef` にdefオブジェクトを追加してください。

---

## ハンドラでの使い方 `worker/api/*.ts`

```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, describeRoute, validator } from 'hono-openapi';
import { eq } from 'drizzle-orm';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../utils/db';
import { users } from '../scheme/index';
import { apiDef, getResponseDefWithAuth, type JsonCtx } from '../../shared/api';
import { omitResAndReq } from '../utils/omit';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

// 【重要】describeResponse のハンドラには必ず JsonCtx<endpoint, Env> を明示する。
// describeResponse は前段の validator から Env・バリデーション入力型を引き継がないため、
// 注釈がないと c.env や c.req.valid('json') の型が壊れる。
// req を使わないハンドラも統一して JsonCtx を付ける。

app.post(
  '/show',
  describeRoute(omitResAndReq(apiDef['/api/users/show'])),
  validator('json', apiDef['/api/users/show'].req),
  describeResponse(async (c: JsonCtx<'/api/users/show', Env>) => {
    const db = getDb(c.env);
    const body = c.req.valid('json');

    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, body.userId))
      .get();

    if (!user) {
      throw new HTTPException(404, { message: 'Not Found' });
    }

    // `, 200`は必須
    return c.json({
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
    }, 200);
  }, getResponseDefWithAuth('/api/users/show')),
  // ↑ authMiddleware を使うルートは getResponseDefWithAuth を使う（401/403を自動付与）
);

export const exampleRoutes = app;
```

---

## API実装で型エラーが出たら？

Hono/hono-openapi のジェネリクスが崩れると広範囲に解読困難な型エラーが出る。以下を順番に確認する。

### 1. res の全エントリに `content` + `vSchema` があるか（最頻出）

`describeResponse` は各エントリの `vSchema` から型パラメータ `T` を推論する。  
`description` だけのエントリが1つでもあると `T` の推論が壊れ `Handler<Env,...>` の不一致エラーが連鎖する。

```ts
// ❌ NG: description だけのエントリがあると型エラー
res: {
  200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
  400: { description: 'Bad request' }, // ← これがあるだけで全体が壊れる
}

// ✅ OK: 全エントリに content + vSchema
res: {
  200: { description: 'Success', content: { 'application/json': { vSchema: v.object({ ok: v.literal(true) }) } } },
  400: { description: 'Bad request', content: { 'application/json': { vSchema: ErrorResponse } } },
}
```

### 2. ハンドラの `c` に `JsonCtx<endpoint, Env>` が付いているか

`describeResponse` は前段 `validator` の型 (`E`/`I`) を引き継がないため、`c` に注釈がないと `c.env` が `object` 、`c.req.valid('json')` が `never` になる。

```ts
// ❌ NG
describeResponse(async (c) => { ... }, res)

// ✅ OK
describeResponse(async (c: JsonCtx<'/api/endpoint', Env>) => { ... }, res)
```

### 3. `getResponseDefWithAuth` の 401 競合

endpoint の `res` に `401` が定義されていると `authErrorResponses` の `401` と交差して `description: never` になる場合があった（修正済み）。`getResponseDefWithAuth` は endpoint の `res` でauth側を上書きする型になっている。
