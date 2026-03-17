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
  - 下記のドキュメントを参考に必要な場合に限りuseEffectを利用
  - https://react.dev/learn/you-might-not-need-an-effect
- useEffectでAPI Callすることを禁じる
- useCallback, useMemoの利用を避ける
  - パフォーマンスに問題が発生した場合のみ利用を検討する
- propsはinterfaceではなくtypeで定義する
- propsの型定義はAPIのレスポンスから推論する
- コンポーネント表示/非表示の制御はActivityコンポーネントを利用する
  - `<Activity mode={isVisible ? 'visible' : 'hidden'}>...</Activity>`
  - typeが絞り込めないケースのみActivityを利用しない
- コンポーネントをArray.prototype.mapで描画する場合のcallback関数は必ず `{}`, `return` を用いて記述する
