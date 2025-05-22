---
applyTo: "**/*.ts,**/*.tsx.**.mts,**/*.cts"
---
# Project TypeScript coding standards

Apply the [general coding guidelines](./general.instructions.md) to all code.
Apply the [general coding guidelines](./javascript.instructions.md) to all code.

- Node.jsで実行する場合は `ts-node` などのライブラリを利用を禁止し `strip-types` を利用する
- 最新のバージョンに従った書き方をする

## Guidelines

- interfaceよりtypeを優先して利用する
- できる限り `as const` を記述する
- baseUrlを利用しない