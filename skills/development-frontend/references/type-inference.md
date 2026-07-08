# 型推論ガイドライン

## 原則

既に存在する型は再定義せず、既存ソースから推論で導出する。props だけでなく、コンポーネント内で扱うすべてのデータ型に適用される。

## 既存型のソース（優先順）

1. Server action (`actions.ts`) の return 型 → `ExtractSuccessData<Awaited<ReturnType<typeof fn>>>`
2. Shared schema (TypeSpec 生成型) → `schema.paths[...]['responses'][...]['content']['application/json']`
3. 共通コンポーネントの props 型 → `ComponentProps<typeof Component>` や `Component['props']`
4. Prisma の payload (API 側のみ) → `Prisma.*GetPayload<typeof select>`

## 判断フロー

1. 型を書く前に自問する: 「この形の型は既にどこかから導出できないか？」
2. 対応する API 呼び出し、schema、共通コンポーネントを先に確認する
3. どうしても新規に書く必要がある場合は、最も近い既存型から `Pick` / `Omit` / `NonNullable` / 添字アクセス `[number]` で導出を試みる
4. 完全に独立した新規型である確証が取れるまで、手書きの object 型を書かない

## よくある違反

- API が返すデータ構造と同じ型を、コンポーネント内で手書きで再宣言する
- 共通コンポーネントの props 型のサブセットを手書きで別宣言する
- Pick で導出できる場面で `{ id, name }` のような部分型を手書きする
- 型の由来が同じなのに、コンポーネントごとに独立して書き直す
