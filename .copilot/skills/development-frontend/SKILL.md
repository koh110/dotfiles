---
name: development-frontend
description: 'TRIGGER when: creating or editing .tsx/.jsx files, creating or editing React components, writing JSX with conditional rendering, or modifying pages/layouts in Next.js. Enforces zod/mini validation, shared UI conventions, and React best practices including Activity for show/hide, useEffect restrictions, and component patterns.'
---

## General Guidelines

- 共通UIを優先して利用する
- 共通するデザイン等は共通UIにリファクタリングする
- client sideでのformはreact-hook-formを利用する

## Zod Guidelines

- zodを利用する場合は `zod/mini` を利用する
  - `import * as z from 'zod/mini'`
  - ref: https://zod.dev/packages/mini

## React Guidelines

- 後方互換性は必要ない
- ReactのコンポーネントはArrow Functionではなく通常のFunctionを利用する
- useEffectを変更検知で利用することを禁じる
  - 下記のドキュメントを参考に必要な場合に限りuseEffectを利用
  - ref: https://react.dev/learn/you-might-not-need-an-effect
- useEffectでAPI Callすることを禁じる
- useCallback, useMemoの利用を避ける
  - パフォーマンスに問題が発生した場合のみ利用を検討する
- propsはinterfaceではなくtypeで定義する
- propsの型定義はAPIのレスポンスから推論する
- コンポーネント表示/非表示の制御はActivityコンポーネントを利用する
  - `<Activity mode={condition ? 'visible' : 'hidden'}>` パターンを使用する
  - `{condition && <Component />}` のような条件付きレンダリングではなく Activity を優先する
  - type が絞り込めないケース（例: `null` から non-null への型ナローイング）のみ Activity を利用しない
- コンポーネントをArray.prototype.mapで描画する場合のcallback関数は必ず `{}`, `return` を用いて記述する

## React Hook Form Guidelines

- formデータの保持にuseStateを利用せず、react-hook-formの機能を活用する
- checkboxやselect等のフォーム要素は `register` で直接バインドし、`watch` + `setValue` による手動ハンドリングを禁じる
- input タグには `value` ではなく `defaultValue` を使用する（`value` はユーザー操作を上書きする可能性がある）
- checkbox配列の `defaultValues` はDOM valueと型を一致させる（DOM valueは常に `string` のため、`string[]` で定義する）
  - submit時に `data.organizationIds.map(Number)` 等で数値変換する
- フォーム全体のリセットは `reset()` ではなく、React の `key` を更新してコンポーネントを再マウントする

## Next.js Guidelines

- Next.jsのベストプラクティスに従う
- ページ単位でのみ共通のUIは各pageをバーチャルルートで共通化し、`{pagedir}/_components/index.ts` にまとめる
- API通信パターン
  - **GET（データ取得）**: Server Actions（`actions.ts`）で実装する
    - `'use server'` + `server-only` で認証・キャッシュタグ管理をサーバーサイドで行う
    - `Result<T, string>` 型で返す
  - **POST/PUT/DELETE（データ変更）**: Proxy経由のクライアントサイド関数で実装する
    - `features/` 配下のclient.tsにAPI関数を定義し、`/proxy/api/...` 経由でリクエストする
    - ダイアログコンポーネントでは `onSubmit` + `useState` で状態管理し、成功時は `onSuccess` コールバックで親に通知する
