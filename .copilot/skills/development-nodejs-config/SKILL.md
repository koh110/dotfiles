---
name: development-nodejs-config
description: Skills for accessing env vars through config in Node.js.
---

- Node.js 開発では `process.env` を各所で参照することを禁じる
- 環境変数は `config.ts` または `config.js` からのみ読み取る
- 他のモジュールは `config` を import して値を参照する
- `config` 以外で `process.env` を参照しない
