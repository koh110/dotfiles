---
name: development-frontend
description: 'Use when writing or editing frontend components, pages, or UI logic with React or Vue. Enforces zod/mini validation, shared UI conventions, and React best practices including Activity, useEffect restrictions, and component patterns.'
---

## General Guidelines

- 共通UIを優先して利用する
- 共通するデザイン等は共通UIにリファクタリングする

## Zod Guidelines

- zodを利用する場合は `zod/mini` を利用する
  - 利用の仕方は下記ドキュメントを参照
  - https://zod.dev/packages/mini
  - `import * as z from 'zod/mini'`

## React Guidelines

- 後方互換性は必要ない
- ReactのコンポーネントはArrow Functionではなく通常のFunctionを利用する
- useEffectを変更検知で利用することを禁じる
  - 参考: https://react.dev/learn/you-might-not-need-an-effect
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
