---
name: development-javascript
description: 'Use when writing or editing JavaScript/TypeScript/Node.js code. Enforces coding style, module conventions, package.json standards, and Node.js CLI tool patterns.'
---

- `"` より `'` を優先して利用する
- 文末のセミコロンは省略する
- classを利用した設計を避ける
  - 関数とオブジェクトリテラルを組み合わせたモジュールパターンを利用する
- 関数定義はarrow functionよりnormal functionを優先する
  - filter, map, reduceなどのcallback関数はarrow functionを利用する
- arrow functionを利用する場合は改行, `{}`, `return` を省略せずに記述する
- Array.prototype.forEachの利用を禁じる
  - for...ofやforループを利用する
- import/requireは相対パスを利用する
- import/requireでindexを省略しない

## Environment Variables

- `process.env` を各所で参照することを禁じる
- 環境変数は `config.ts` または `config.js` からのみ読み取る
- 他のモジュールは `config` を import して値を参照する

## Scripting

- 使い捨てのスクリプトを作成・実行する場合は最新バージョンのNode.jsを利用する
- 一時的な自動化でもPythonやBashでの実装を禁じる

## package.json Guidelines

- はじめてpackage.jsonを作成する場合は下記のみで構成する
  - `private: true` と `type: "module"` のみを記述
  - `name`, `main`, `version`, `author`, `license`, `description`, `keywords` は用いない

```json
{
  "private": true,
  "type": "module"
}
```

## Test Guidelines

- `describe` を利用しない。`test` をファイルのルートレベルに記述する
- テストをグルーピングしたい場合は `describe` ではなくテストファイル自体を分離する

## TypeScript Guidelines

- Prefer `type` over `interface`
- type assertion を禁じる
- 推論できる型は推論を優先して採用し、再定義を禁じる
- functionの返り値は指定せず推論に任せる
- baseUrlを利用しない
- 可能な場合は必ず `as const` を記述する
- `any` 型の利用を禁じる
  - やむをえない場合は `unknown` 型を利用し、type guardで型を絞り込む
  - 外部ライブラリの型定義が不完全な場合のみ、コメントで理由を明記した上で使用を許可する
- TypeScriptファイルを直接実行する場合はNode.jsのstrip-typesを利用する
  - `ts-node`, `tsx` の利用を禁じる
  - ref: https://nodejs.org/docs/api/typescript.html

## Node.js CLI Tool Guidelines

Node.js CLIツールを作成する場合は以下に従う。

- ファイルの先頭に `#!/usr/bin/env node` を付与する
- 引数解析は `node:util` から `parseArgs` をインポートして利用し、手書きパーサは避ける
  - `commander` などの利用は禁じる
- TypeScriptで記述し、Node.jsのstrip-typesで実行する

### CLI用 package.json Template

```json
{
  "private": true,
  "type": "module",
  "bin": {
    "my-cli": "./bin/cli.js"
  }
}
```

### CLI Entry Point Template

```javascript
#!/usr/bin/env node
// ./deploy.ts --help
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
    }
  }
})

async function main() {
  if (values.help) {
    await xxx()
    return
  }
}
main().catch(console.error)
```

### CLI用 tsconfig.json Template

```json
{
  "compilerOptions": {
    "incremental": true,
    "strict": true,
    "outDir": "dist",
    "sourceMap": true,
    "esModuleInterop": true,
    "target": "esnext",
    "module": "nodenext",
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  }
}
```
