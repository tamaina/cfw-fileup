---
name: api
description: "APIのプロトコルとソースの場所。"
tags: [api, typescript, hono, schema, openapi]
---

## 概要

- `packages/app/src/shared/api/index.ts` - APIスキーマ定義ファイルのインデックス
- `packages/app/src/shared/api/*.ts` - APIスキーマ定義ファイル
- `packages/app/src/worker/api/*.ts` - API実装ファイル ハンドラ

## プロトコル
- エンドポイントは`/api/`以下。
- apiリクエストはなんでもかんでも`applications/json`をbodyにした`POST`にしたい  
  ただ、次のような場面ではGETにする。性質上、要求はクエリ文字列にする
  * 全ユーザーに対してキャッシュを効かせられる
    * 短期間 - `/api/meta`
    * 長期間
    * etagを利用

---

## 定義ファイル `shared/api/*.ts`

```ts
import * as v from 'valibot';
import type { ApiEndpointDefinitionRecord } from '../api.js';

// OpenAPI ref ... 複数のAPIでスキーマを応答する場合
const UserResponse = v.pipe(
  v.object({
    id: v.string(),
    username: v.string(),
    isAdmin: v.boolean(),
  }),
	v.metadata({ ref: 'User' }),
);

// api def ... エンドポイントをオブジェクトで定義
export const exampleApiDef = {
	'/api/users/show': {
    summary: 'Get account info from user id',
    tags: ['users'],

    // 要求: Valibot
		req: v.object({
      userId: v.string(),
    }),

    // 応答: describeResponseの第2引数
		res: {
			200: {
        // description必須
        description: "Success",
        content: { 'application/json': { vSchema: UserResponse } }
      },
			401: { description: 'Unauthorized' },
		},
	},
	'/api/account/me': {
    summary: 'Get account info from authentication token',
    tags: ['account'],
    // hide: true

    // 空の要求
		req: v.object({}),

    // 応答: describeResponseがの第2引数
		res: {
			200: { content: { 'application/json': { vSchema: UserResponse } } },
			404: { description: 'Not Found' },
		},
	},
} as const satisfies ApiEndpointDefinitionRecord;
```

## インデックスファイル `shared/api/index.ts`
新しいAPIファイルを作成する場合は、index.tsのapiDefにdefオブジェクトを追加してください。

## ハンドラでの使い方 `worker/api/*.ts`

```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describeResponse, validator } from 'hono-openapi';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../utils/db';
import { users } from '../scheme/index';
import { apiDef } from '../../shared/api'; // shared/api/index
import { omitResAndReq } from '../utils/omit';

const app = new Hono<{ Bindings: Env }>();

app.use(authMiddleware);

app.post(
  '/api/account/me',
  describeRoute(omitResAndReq(apiDef['/api/account/me'])),
  validator('json', apiDef['/api/account/me'].req),
  describeResponse(async (c) => {
    const user = c.get('user');
    return c.json({
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
    }, 200);
  }, apiDef['/api/account/me'].res)
);

app.post(
  '/api/users/show',
  describeRoute(omitResAndReq(apiDef['/api/users/show'])),
  validator('json', apiDef['/api/users/show'].req),
  describeResponse(async (c) => {
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

    return c.json({
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
    }, 200);
  }, apiDef['/api/users/show'].res)
);

export const exampleRoutes = app;
```
