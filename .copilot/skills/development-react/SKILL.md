---
name: development-react
description: Skills for React development guidelines.
---

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
