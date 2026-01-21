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
- `package.json` は `type: module` を利用し、ESMとする

## React Guidelines

- ReactのコンポーネントはArrow Functionではなく通常のFunctionを利用する
- 以下のガイドラインに従う
  - https://react.dev/learn/you-might-not-need-an-effect
- useEffectを変更検知で利用することを禁じる
- useCallback, useMemoの利用を避ける
  - パフォーマンスに問題が発生した場合のみ利用を検討する
- propsはinterfaceではなくtypeで定義する
- コンポーネント表示/非表示の制御はActivityコンポーネントを利用する
  - typeが絞り込めないケースのみActivityを利用しない
- コンポーネントをArray.prototype.mapで描画する場合のcallback関数は必ず `{}`, `return` を用いて記述する
