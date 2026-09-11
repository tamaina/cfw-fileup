# ブラウザでのストリーム保存

展開・BGZF 再圧縮・復号・tar/ZIP 生成の順次出力は、既存の Service Worker に渡し、ブラウザのダウンロードとして保存する。StreamSaver.js と同じ attachment Response の方式を独立実装しており、同ライブラリの依存追加や外部の中継ページは不要。

- `resolveSaveTarget` が `TransformStream` を作り、Readable 側を既存 SW に転送する。
- SW の受信確認後、一度だけ使えるランダムな `/__stream-download/<uuid>` をクリックし、Writable 側を処理用 Web Worker に転送する。
- SW は `Content-Disposition: attachment` / `Cache-Control: no-store` を付けて返す。変換後サイズが不明なので Content-Length は付けない。
- 未使用の URL は30秒で破棄する。ブラウザ側の中止はストリームの cancel で伝播し、生成側の失敗は abort と制御ポートでレスポンスを失敗させる。
- SW が未制御・旧版・転送非対応の場合は、保存ダイアログ、OPFS の順にフォールバックする。開始後の失敗では別方式へ自動再試行しない。
- seek を使う HLS → MP4 は `sequential=false` で従来の保存方式を使う。

出力全体を OPFS に置く必要はなくなるが、既存の Range 読み込みバッファやアーカイブ内の復号処理用バッファまでなくなるわけではない。タブ内の画面移動は継続できるが、タブを閉じる・再読み込みすると生成処理が止まるため、処理中は beforeunload で確認する。

アプリの完了表示は生成ストリームを書き終えたことを表す。OSへの保存完了や最終的なファイル名はブラウザのダウンロード管理に委ねる。

検証: `pnpm --filter app exec vitest run test/stream-download.test.ts test/download-resilience.test.ts`、`pnpm --filter app test:e2e stream-download.spec.ts`。後者は実 SW と Web Worker を使い、OPFS・picker を禁止した状態で BGZF の展開・再圧縮後の保存内容を比較する。Firefox / Safari の互換性は別途実ブラウザで確認する必要がある。

## 実施した検証

- Chromium: BGZF 展開、通常 gzip への再圧縮、tar/ZIP 生成の保存内容一致、生成側 abort 時のダウンロード失敗（E2E 5件）。
- SW の URL 失効・キャンセル伝播・保存先フォールバックと既存 Range 再試行テスト（計17件）。
- 全体・client・SW の型チェック、本番 Vite/PWA ビルド成功。対象 ESLint はエラーなし（警告あり）。
- E2E の共通 signup はローカルのパスフレーズ不一致で403を返すが、このテストは認証不要の固定データを使うため影響しない。
- Firefox / Safari、および GB 単位の長時間保存は未検証。
