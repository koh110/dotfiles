# コーディングスタイル

## 原則

- プロジェクトのlintルールを優先する
- lintルールにそうための修正など、変更したい内容に直接関係のない変更は避ける
- Node.jsの場合は最新のバージョンを利用したコードを生成する
- JavaScriptよりTypeScriptを優先して利用する

### JavaScript

- はじめてpackage.jsonを作成する場合は、`private: true` を用いて必要最低限のパラメータのみ利用する
  - 次のパラメータは利用しない
    - name
    - main
    - version
    - author
    - license
    - description
    - keywords
- `package.json` の `type` は `module` を利用し、ESMを基本とする
- `"` より `'` を優先して利用する
- 文末のセミコロンは省略する
- arrow functionを利用する場合は改行, `{}`, `return` をできるだけ省略せずに記述する
- 環境変数を扱う処理はconfig.jsにまとめる

### TypeScript

- JavaScriptのルールを包括する
- Node.jsで実行する場合は `ts-node` などのライブラリを利用を禁止し `--experimental-strip-types` を利用する
- 最新のバージョンに従った書き方をする
- interfaceよりtypeを優先して利用する
- できる限り `as const` を利用する
