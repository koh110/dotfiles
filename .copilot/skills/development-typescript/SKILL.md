---
name: development-typescript
description: Skills for TypeScript development, including Node.js, frontend frameworks, and tooling.
---

- Prefer `type` over `interface`.
- type assertion を禁じる
- 推論できる型は推論を優先して採用し、再定義を禁じる
- baseUrlを利用しない
- 可能な場合は必ず `as const` を記述する
- `any` 型の利用を禁じる
  - やむをえない場合は `unknown` 型を利用し、type guardで型を絞り込む
  - 外部ライブラリの型定義が不完全な場合のみ、コメントで理由を明記した上で使用を許可する
- typescriptファイルを直接実行する場合はNode.jsのstrip typesを利用する
  - `ts-node`, `tsx` の利用を禁じる
- functionの返り値は指定せず推論に任せる
- classを利用した設計を避ける
  - 関数とオブジェクトリテラルを組み合わせたモジュールパターンを利用する
