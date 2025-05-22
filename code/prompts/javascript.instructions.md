---
applyTo: "**/*.js,**/*.mjs,**/*.cjs,**/*.jsx"
---
# Project JavaScript coding standards

Apply the [general coding guidelines](./general.instructions.md) to all code.

## Guidelines

- `"` より `'` を優先して利用する
- 文末のセミコロンは省略する
- arrow functionを利用する場合は改行, `{}`, `return` を省略せずに記述する
- 環境変数を扱う処理はconfig.jsにまとめる
- import/requireは相対パスを利用する

## package.json Guidelines

- はじめてpackage.jsonを作成する場合は、`private: true` を用いる。
- はじめてpackage.jsonを作成する場合は、`name` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`main` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`version` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`author` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`license` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`description` プロパティを用いない
- はじめてpackage.jsonを作成する場合は、`keywords` プロパティを用いない
- `package.json` は `type: module` を利用し、ESMとする

## React Guidelines

- ReactのコンポーネントはArrow Functionではなく通常のFunctionを利用する
