---
applyTo: "**/*.ts,**/*.tsx.**.mts,**/*.cts"
---
# Project TypeScript coding standards

Apply the [general coding guidelines](./general.instructions.md) to all code.
Apply the [general coding guidelines](./javascript.instructions.md) to all code.

- Node.jsで実行する場合は `ts-node` などのライブラリを利用を禁止し `strip-types` を利用する
- 最新のバージョンに従った書き方をする

## Guidelines

- 推論できる型は推論を優先して採用し、再定義を禁じる
- interfaceは利用せずtypeを利用する
- 可能な場合は必ず `as const` を記述する
- baseUrlを利用しない
- any型を利用しない
