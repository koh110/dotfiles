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
- 既に存在する型は再定義を禁じ推論で導出する（propsに限らずコンポーネント内のすべての型に適用）
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

## Mandatory Skill Enforcement

- このskillがloadされたら、実装前に以下の禁止事項を内部チェックリストとして固定し、実装中に見失わないこと
  - `useEffect` を変更検知で使わない
  - `useEffect` で API call しない
  - `{condition && <Component />}` を安易に使わず `Activity` を優先する
- `.tsx` / `.jsx` を変更した場合、完了報告前に **変更した各ファイル** を再読し、上記禁止事項に違反していないか必ず確認すること
- 1つでも違反が見つかった場合、その時点で「未完了」とみなし、説明より先に実装修正を優先すること
- 特に `useEffect(` を追加・変更した場合は、「変更検知か」「API callか」を明示的に自己監査し、どちらかに該当するなら削除または別設計へ置き換えること
