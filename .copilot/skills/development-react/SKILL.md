---
name: development-react
description: 'Guidelines for React development.'
---

- 後方互換性は必要ない
- ReactのコンポーネントはArrow Functionではなく通常のFunctionを利用する
- 以下のURLに記載されたガイドラインに従う
  - https://react.dev/learn/you-might-not-need-an-effect
- useEffectを変更検知で利用することを禁じる
  - 下記のドキュメントを参考に必要な場合に限りuseEffectを利用
  - https://react.dev/learn/you-might-not-need-an-effect
- useEffectでAPI Callすることを禁じる
- useCallback, useMemoの利用を避ける
  - パフォーマンスに問題が発生した場合のみ利用を検討する
- propsはinterfaceではなくtypeで定義する
- propsの型定義はAPIのレスポンスから推論する
- コンポーネントの表示/非表示の制御は React の `Activity` コンポーネントを利用する
  - `<Activity mode={condition ? 'visible' : 'hidden'}>` パターンを使用する
  - `{condition && <Component />}` のような条件付きレンダリングではなく Activity を優先する
  - type が絞り込めないケース（例: `null` から non-null への型ナローイング）のみ Activity を利用しない
- コンポーネントをArray.prototype.mapで描画する場合のcallback関数は必ず `{}`, `return` を用いて記述する
