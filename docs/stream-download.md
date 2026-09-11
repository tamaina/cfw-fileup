# ブラウザでのストリーム保存

展開・BGZF 再圧縮・復号・tar/ZIP 生成の順次出力は、既存の Service Worker に渡し、ブラウザのダウンロードとして保存する。StreamSaver.js と同じ attachment Response の方式を独立実装しており、同ライブラリの依存追加や外部の中継ページは不要。

- `resolveSaveTarget` が `TransformStream` を作り、Readable 側を既存 SW に転送する。
- SW の受信確認後、一度だけ使えるランダムな `/__stream-download/<uuid>` へ非表示 iframe を遷移させ、Writable 側を処理用 Web Worker に転送する。
- SW は `Content-Disposition: attachment` / `Cache-Control: no-store` を付けて返す。変換後サイズが不明なので Content-Length は付けない。
- 未使用の URL は30秒で破棄する。ブラウザ側の中止はストリームの cancel で伝播し、生成側の失敗はページが保持する TransformStream の controller からレスポンスを失敗させる。Writable 側の転送先 Worker が強制終了しても中止できる。
- SW が未制御・旧版・転送非対応の場合は、保存ダイアログ、OPFS の順にフォールバックする。開始後の失敗では別方式へ自動再試行しない。
- 保存中は `waitUntil` で SW の仕事を保持し、10秒ごとに継続通知を送る。完了・中止・ページ離脱で通知を止める。SW の寿命保持はレスポンスの終端・エラー・キャンセルまで継続する。
- v2 プロトコルで受信確認する。旧 SW と新クライアントの混在時は従来の保存方式へフォールバックする。
- seek を使う HLS → MP4 は `sequential=false` で従来の保存方式を使う。

出力全体を OPFS に置く必要はなくなるが、既存の Range 読み込みバッファやアーカイブ内の復号処理用バッファまでなくなるわけではない。タブ内の画面移動は継続できるが、タブを閉じる・再読み込みすると生成処理が止まるため、処理中は beforeunload で確認する。

アプリの完了表示は生成ストリームを書き終えたことを表す。OSへの保存完了や最終的なファイル名はブラウザのダウンロード管理に委ねる。

検証: `pnpm --filter app exec vitest run test/stream-download.test.ts test/download-resilience.test.ts`、`pnpm --filter app test:e2e stream-download.spec.ts`。後者は実 SW と Web Worker を使い、OPFS・picker を禁止した状態で BGZF の展開・再圧縮後の保存内容を比較する。Firefox の保存経路は下記の独立 E2E で検証する。Safari は未検証。

## 実施した検証

- Chromium: BGZF 展開、通常 gzip への再圧縮、tar/ZIP 生成の保存内容一致、生成側 abort 時のダウンロード失敗（E2E 5件）。
- SW の URL 失効・キャンセル伝播・保存先フォールバックと既存 Range 再試行テスト（計21件）。
- 全体・client・SW の型チェック、本番 Vite/PWA ビルド成功。対象 ESLint はエラーなし（警告あり）。
- E2E の共通 signup はローカルのパスフレーズ不一致で403を返すが、このテストは認証不要の固定データを使うため影響しない。
- Safari、および GB 単位の長時間保存は未検証。

## 途中完了の再現と回帰テスト

Firefox で64 KiBを書いたあと45秒待ち、さらに64 KiBを書くと、旧実装では保存が正常完了扱いのまま64 KiBだけになることを再現した。ストリームを直接 Response に渡し、waitUntil を追加すると45秒の待機は通るが、350秒では再び64 KiBになる。これを受けて、転送ストリームの利用時も保存中の継続通知を追加した。[StreamSaver.js の中継ページ](https://github.com/jimmywarting/StreamSaver.js/blob/master/mitm.html) も、Firefox 向けに転送ストリームの場合を含め10秒ごとの通知を行っている。

保存経路の独立 E2E は DB・認証・Vite を起動せず、実際の SW と転送先 Web Worker を使う。Chromium / Firefox で、待機中に完了扱いにならないこと、保存内容の全量一致、連続保存を検証する。生成 Worker 強制終了後のダウンロード失敗通知は Chromium で検証する。Firefox はレスポンスエラーをコンソールに報告するが、Playwright の download.failure() が返らずタイムアウトするため、この1件を明示的に skip している。Firefox の中止表示は未確認。Firefox の通常テストでは idle timeout と extended idle timeout を短縮し、両方を越えて待機する。

継続通知追加後は独立 E2E が5件成功・1件 skip。通常設定の Firefox でも350秒待機後の128 KiBが全量一致した（1件成功、5.9分）。この試験は待機時間に対する寿命の検証であり、大容量転送の性能測定ではない。

```sh
TMPDIR=/var/tmp pnpm --filter app exec playwright test --config playwright.stream.config.ts
TMPDIR=/var/tmp STREAM_DOWNLOAD_DEFAULT_TIMEOUTS=1 STREAM_DOWNLOAD_IDLE_MS=350000 pnpm --filter app exec playwright test --config playwright.stream.config.ts --project=firefox --grep 'idle period'
```

テストの「別タブに移動」は bringToFront を使うが、Playwright はページの focus / visibility をエミュレートするため、実ブラウザのバックグラウンド制限すべてを再現するものではない。OSによるタブ破棄・プロセス強制終了からの継続や、Safari の動作は保証していない。
