# File uploader with Cloudflare Workers (仮)
Cloudflare WorkersおよびR2を使用したファイルアップローダーのプロジェクト

## Features TODO
実装アイデア

- [x] Cloudflare Workers/R2/D1で安価に動作
- [ ] tar.gzの中身を閲覧・1ファイルずつダウンロード
- ユーザー作成・ファイル管理機能
  * [ ] サインアップ/ログイン機能
    * 他のサービスのアカウントでサインアップ
       * [ ] Misskeyアカウントログイン(IndieAuth)
       * [ ] Googleアカウントログイン
    * [ ] パスキーでサインアップ・ログイン
  * [ ] バケットを作成してファイルを管理
     * [ ] バケットを他のユーザーと共有
  * [ ] 閲覧権限設定
- [ ] ファイルダウンロードの合言葉設定
- ファイルアップロード前にブラウザで変換
  * [ ] 画像圧縮, Exif削除
  * [ ] 動画圧縮
  * [ ] フォルダをtar.gzにまとめる(アップロード後はtar.gzは変更不可)
- [ ] Resumable Uploads for HTTP
- クライアント(Vue SPA)を多言語対応で準備
- 管理者によるモデレーション
  - [ ] 管理者アカウントフラグとモデレーション画面へのアクセス
  - [ ] 新規登録受付可否、アカウント登録時の合言葉設定  
  (合言葉はenvで設定、最初の管理者アカウント作成は合言葉必須)
    * [ ] 招待コード制？
  - [ ] アカウント凍結
  - [ ] アップロードされたファイルの削除

## Endpoints
- `/upload/:fileId` - Resumable Uploads for HTTP用。アップロードはこのエンドポイントに対して行う。
- `/d/:bucketName/:filePath` - `GET`でファイルのダウンロード。`/`で終わったらディレクトリなのでインデックスを返す。`DELETE`でファイルを削除。
  tar.gzの場合、`?list`/`?list=path/to/dir`クエリでインデックスを返す。`?file=path/to/file`クエリで中身の特定ファイルをダウンロード。
- `/api` - 各種操作 全てJSONデータの`POST`
  * **bucket関連**
    * `/api/buckets/create` - バケットを作成するためのエンドポイント。バケット名を指定してバケットIDを生成して返す。
    * `/api/buckets/delete` - バケットを削除するためのエンドポイント。バケットIDを指定。全てのファイルも削除される。
    * `/api/buckets/list` - バケットの一覧を取得するためのエンドポイント。ユーザーIDを指定して、そのユーザーが所有するバケットのIDと名前のリストを返す。
  * **file関連**
    * `/api/files/create/open` - ファイルアップロードを開始するためのエンドポイント。バケットIDとファイルパスを指定し、ファイルIDを生成してアップロード期限とともに返す。
    * `/api/files/create/targz-index` - tar.gzのインデックスを登録するためのエンドポイント。ファイルIDを指定して、tar.gzに対する ファイルパス-MIMEタイプ-BGZF開始バイト位置-BGZF終端バイト位置-解凍後ファイル開始オフセットバイト数 のリストを送信。
    * `/api/files/create/close` - ファイルアップロードの完了を明示するためのエンドポイント。ファイルID、非ログインユーザーへの公開設定、合言葉を指定。レジュームアップロードが終わっていなければエラー。
    * `/api/files/delete` - ファイルを削除するためのエンドポイント。ファイルパスを指定。
  * **ユーザー認証**
    * `/api/signup` - サインアップ用。ユーザー名、パスワード、合言葉を指定してユーザーIDとトークンを生成。
    * `/api/signin` - サインイン用。ユーザー名とパスワードを指定してトークンを返す。
  * **アカウント設定**
    * `/api/account/update` - アカウント情報を更新するためのエンドポイント。ユーザーIDと更新する情報を送信。
  * **モデレーション**
    * `/api/admin/suspend-user` - アカウント凍結用。ユーザーIDを指定してアカウントを凍結。
    * `/api/admin/delete-file` - ファイル削除用。ファイルIDを指定してファイルを削除。
    * `/api/admin/delete-bucket` - バケット削除用。バケットIDを指定してバケットを削除。
    * `/api/admin/toggle-registration` - 新規登録受付のON/OFF切り替え用。ON/OFFを指定して切り替え。

## How to develop (Hono)
```bash
npm install
npm run dev
```

```bash
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```bash
npm run cf-typegen
```

Pass the `Env` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: Env }>()
```
