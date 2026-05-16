---
name: typescript-type
description: "TypeScriptの型の書き方。型が合わないときはここを見ると解決するかもしれません。"
context: fork
tags: [troubleshoot, d1, port]
---

- `as unknown as`は避ける。TypeScriptを使っている意味がなくなります。もしどうしても使いたくなったら、使ってもいいですがPRの説明文の上のほうに書いてください。
- `Uint8Array`は`Uint8Array<ArrayBuffer>`と書く。`Uint8Array`は殆ど不要な`Uint8Array<SharedArrayBuffer>`を含み、型の不整合が起きやすくなります。
