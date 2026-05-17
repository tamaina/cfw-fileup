# package.json を編集したら必ず pnpm install を実行

`package.json` に依存パッケージを追加・削除・変更した場合、必ず `pnpm install` を実行して `pnpm-lock.yaml` を更新し、**両方をコミット**すること。

CIは `pnpm install --frozen-lockfile` を使うため、lockfile が package.json と一致していないと即座にCIが失敗する。
