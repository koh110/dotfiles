---
name: development-frontend
description: 'TRIGGER when: creating or editing .tsx/.jsx/.css/.scss files, creating or editing React components, writing JSX with conditional rendering, modifying pages/layouts in Next.js, or debugging responsive frontend layout. Enforces zod/mini validation, shared UI conventions, React best practices including Activity for show/hide, useEffect restrictions, component patterns, and effective responsive CSS verification.'
---

## General Guidelines

- 共通UIを優先して利用する
- 共通するデザイン等は共通UIにリファクタリングする
- 各ガイドラインのNG/OKコード例は [references/react-patterns.md](references/react-patterns.md) を参照する。禁止パターンに該当しそうな実装を書く前に必ず該当セクションを確認する

## Zod Guidelines

- zodを利用する場合は `zod/mini` を利用する
  - `import * as z from 'zod/mini'`
  - ref: https://zod.dev/packages/mini

## Responsive Layout Verification

- レスポンシブUIの変更では、media queryやselectorの宣言が存在するだけで完了扱いにしない。source order、specificity、`!important`、DOM順序を含むcascade後の実効値を確認する
- 対象となる狭い幅・短い高さ・長い文言などのviewport条件を明示し、computed styleまたはDOMの実測geometryで、主要な操作対象・本文・ダイアログが重ならず到達可能であることを確認する
- breakpointやlayout geometryに影響しないCSS変更（色、typography tokenなど）は、responsive geometry検証をN/Aとし、その理由を独立reviewのinputsへ渡す
- CSS/build pipelineがcompiled assetを生成する場合は、最終build後のassetが検証したsourceと一致することを確認する。生成物をcommitするrepositoryでは、stageと未stage差分の扱いは`git-workflow`の「Commit / Rebase / Push Guidelines」にある生成物手順に従う
- 対象viewport条件が変更対象に存在しない場合はgeometry検証をN/Aとし、compiled assetを生成しないrepositoryではasset照合をN/Aとする。それぞれ理由を独立reviewのinputsへ渡す。CSS/レイアウト変更がある場合のcascade実効値確認はN/Aにせず、未確認をPASS扱いしない

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
  - `import { Activity } from 'react'`（React 19.2+）
  - `<Activity mode={condition ? 'visible' : 'hidden'}>` パターンを使用する
  - `{condition && <Component />}` のような条件付きレンダリングではなく Activity を優先する
  - 例外1: type が絞り込めないケース（例: `null` から non-null への型ナローイング）のみ Activity を利用しない
  - 例外2: プロジェクトの react バージョンが Activity 未対応（< 19.2）の場合は条件付きレンダリングを使う（存在しない API を import して build を壊さない）
- コンポーネントをArray.prototype.mapで描画する場合のcallback関数は必ず `{}`, `return` を用いて記述する
- client sideでのformはreact-hook-formを利用する
- componentのresetは対象コンポーネントのkeyを変更して行う

## React Hook Form Guidelines

- formデータの保持にuseStateを利用せず、react-hook-formの機能を活用する
- checkboxやselect等のフォーム要素は `register` で直接バインドし、`watch` + `setValue` による手動ハンドリングを禁じる
- input, select 等のtagを利用する共通コンポーネントは `value` での制御ではなく `defaultValue` を使用する（`value` はユーザー操作を上書きする可能性がある）
  - 既存の `defaultValue` ベースの共通コンポーネントを `value` 制御へ変更しない（破壊的 API 変更になり他の利用箇所を壊す）
  - 値のクリアやリセットは `value=''` 制御ではなく React の `key` 更新による再マウントで行う
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
- `.css` / `.scss` を変更した場合、またはbreakpoint依存のclass・style・layout構造を含む `.tsx` / `.jsx` を変更した場合は、完了前にResponsive Layout Verificationのcascade実効値、対象viewportのgeometry、compiled assetの確認（またはN/A理由）を再読チェックへ含めること
