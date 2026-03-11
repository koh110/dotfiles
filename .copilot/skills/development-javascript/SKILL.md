---
name: development-javascript
description: 'Use when writing or editing JavaScript/Node.js code. Enforces coding style, module conventions, and package.json standards.'
---

- `"` より `'` を優先して利用する
- 文末のセミコロンは省略する
- 関数定義はarrow functionよりnormal functionを優先する
- arrow functionを利用する場合は改行, `{}`, `return` を省略せずに記述する

```javascript
const add = (a, b) => {
  return a + b
}
```

- filter, map, reduceなどのcallback関数はarrow functionを利用する
- Array.prototype.forEachの利用を禁じる
  - for...ofやforループを利用する
- import/requireは相対パスを利用する
- import/requireでindexを省略しない

## Environment Variables

- `process.env` を各所で参照することを禁じる
- 環境変数は `config.ts` または `config.js` からのみ読み取る
- 他のモジュールは `config` を import して値を参照する

## Scripting

- 使い捨てのスクリプトを作成・実行する場合は最新バージョンのNode.jsを利用する
- 一時的な自動化でもPythonやBashでの実装を禁じる

## package.json Guidelines

- はじめてpackage.jsonを作成する場合は、`private: true` を用いる。
- はじめてpackage.jsonを作成する場合は、`name` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`main` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`version` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`author` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`license` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`description` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`keywords` プロパティを用いない
- `package.json` は `type: module` を利用し、ECMAScript Moduleとする

```
{
  "private": true,
  "type": "module"
}
```
