---
name: development-javascript
description: Skills for JavaScript development, including Node.js, frontend frameworks, and tooling.
---

- `"` より `'` を優先して利用する
- 文末のセミコロンは省略する
- arrow functionを利用する場合は改行, `{}`, `return` を省略せずに記述する

```javascript
const add = (a, b) => {
  return a + b
}
```

- filter, map, reduceなどのcallback関数はarrow functionを利用する
- 環境変数を扱う処理はconfig.jsにまとめる
- import/requireは相対パスを利用する
- import/requireでindexを省略しない

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
