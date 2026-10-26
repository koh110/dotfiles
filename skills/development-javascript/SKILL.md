---
name: development-javascript
description: 'TRIGGER when: creating or editing .ts/.js/.mts/.mjs files, creating Node.js CLI tools, or modifying package.json. Enforces coding style, module conventions, package.json standards, and Node.js CLI tool patterns.'
---

## Lint and Format (must)

- `.ts` / `.js` を変更したら、完了前にprojectのroot(package.jsonのあるdirectory)で次を実行し、formatとlintを流す

```bash
node <このskillのdirectory>/scripts/check.ts [files...]
```

- filesを省略するとgitの変更ファイル(未追跡を含む)を対象に、`vp fmt`(書き込み) → `vp lint` の順で実行する。`--check` を付けるとformatを書き込まず確認だけ行う
- projectにlint/format設定(`vite.config.*` の `lint`/`fmt`、oxlint/oxfmt、eslint/prettier/biome/dprintの設定ファイル、またはそれらのpackageへの依存)がある場合はproject設定を優先する。vp以外のtoolの場合はscriptがその旨を表示してskipするので、projectのscriptでlint/formatを実行する
- project設定が無い場合はskillの設定(`lint/oxfmt.json`、`lint/oxlint.json`、`lint/plugin.mjs`)を使う
- code style(引用符、セミコロン、関数定義の形式、arrow functionの書き方、変数化)と、lintで検出できるルール(class、import path、forEach、`process.env`、`describe`、引数parser、`interface`、type assertion、返り値の型、`any`、filterの `is`)は文章で定義せず、skillのlint設定を正とする。対応ruleは `lint/oxlint.json` を参照
- errorはすべて修正する。warn(`js-skill/no-single-use-variable`、`js-skill/no-filter-type-predicate`)は判断を伴うため、該当箇所を見直し、残す場合は理由を説明できる状態にする
- disable commentでerrorを抑制してよいのは、外部ライブラリの型定義が不完全な場合など正当な理由があるときだけとし、理由をコメントに明記する
- projectにvite-plusが無い場合、scriptは `npx -p vite-plus@1 vp` で取得する(`npx vp` はplaceholder packageを実行してしまうので使わない)。sandboxで `~/.npm/_npx` に書けず失敗した場合はsandbox外で再実行する

## Environment Variables

- 環境変数は `config.ts` または `config.js` からのみ読み取る
- 他のモジュールは `config` を import して値を参照する

## Date Handling

- DBカラムが timezone-naive(`::timestamp`)か timezone-aware(`::timestamptz`)かによって、渡す文字列の形式を変える
  - **timezone-naive(`::timestamp`)**: `new Date(v).toISOString()` によるUTC文字列（`Z` 付き）をそのまま渡さない。`::timestamp` は `Z` を無視して数値部分だけをそのまま格納するため、UTC文字列を渡すとJSTセッションでは時刻が09:00ずれる。プロジェクトで採用している日付ライブラリ（dayjs等）でtimezone情報を含まない明示フォーマット文字列を生成して渡す
  - **timezone-aware(`::timestamptz`)**: 逆に timezone情報を落とした文字列を渡さない。オフセットのない文字列を渡すとDB側がセッションタイムゾーンとして解釈し、絶対時刻がずれて格納される。`new Date(v).toISOString()` のようなtimezone情報を含む文字列(またはoffset付き文字列)を渡す
  - どちらのキャストを使うかは既存コードの慣習に揃え、同一コードベース内で混在させない

## Scripting

- 使い捨てのスクリプトを作成・実行する場合は最新バージョンのNode.jsを利用する
- 一時的な自動化でもPythonやBashでの実装を禁じる

## npm Guidelines

- .npmrcをプロジェクトルートに配置し、必要に応じて以下の設定を記述する
  - `min-release-age=7` を記述してリリース後すぐのバージョンを避ける

```bash
# .npmrc
min-release-age=7
```

Dockerfile内でnpmを利用する場合は、`npm install` の前に `.npmrc` をコピーして設定を反映させる.
また、.npmrcのビルド忘れを防ぐために `min-release-age` だけはDockerfileのnpm installコマンドにも直接渡す.

```dockerfile
RUN npm install --min-release-age=7
```

- `min-release-age-exclude` を使う場合は npm 11.17.0 以降を要求する（同設定が追加されたバージョン）
- `omit-lockfile-registry-resolved=true` と併用する前に、npm/cli#9715 の修正が利用する npm リリースに含まれていることと、`npm ci` の回帰テストを確認する。少なくとも npm 11.19.1 / 12.2.0 では、lockfile から `resolved` が省略されると、除外対象でも `npm ci` が `ETARGET` になることを確認した。修正が未収録ならこの組み合わせを避け、`resolved` を保持する lockfile で確認する

## Linked Worktree and npm Workspace Verification

- linked worktreeには`node_modules`が伴わないことがある。npm script、`npx`、wrangler等を実行する前に`node_modules/.bin`または対象binaryの実在を確認する
- 依存が不足している場合は、専用worktreeのrepository rootから、同worktreeにあるroot lockfile/workspacesを使って`npm ci`（必要なら`--ignore-scripts`）等を実行する。root checkoutや別worktreeの`node_modules`をコピー・暗黙参照しない
- root lockfile + workspaces構成では、workspace package directory内で無計画な`npm ci`/`npm install`を実行してnested `node_modules`やlockfileを作らない。package managerの解決経路とlockfileの所在を先に確認する
- build・生成・testにworkspace間の依存順序がある場合は、生成元を先に実行し、並列実行で前提を壊さない

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

- 同じモックを複数のテストファイルで使う場合は、共通の mock factory を関数として export し各テストファイルから呼び出す
- DBや外部リソースを共有するテスト同士の干渉を防ぐため「並列耐性」のある形で記述する
  - 同一ファイル内で固有のprefixを共有することを禁じる。テスト毎に `task.id` などのtestごとに unique となる値を prefix として利用し、seed を分離する
  - `beforeAll` で共通の seed データを作成することを禁じる。`beforeAll` は接続と必要最小限の truncate のみに留め、seed は各テスト内で `task.id` prefix を付けて作成する
  - 共有リソース全体に依存する assertion (例: `count`, `length`) を禁じる。`find()` 等で自テストが作成したレコードのみを対象に assertion する
- サンプルとNGパターンは [references/tests.md](references/tests.md) を参照

## TypeScript Guidelines

- 既に存在する型は再定義せず推論で導出し再定義を禁じる（対象を限らずすべての型に適用）
  - 詳細は [references/type-inference.md](references/type-inference.md) を参照
- baseUrlを利用しない
- npm workspaces monorepoで他packageを参照する場合、tsconfigの `paths` エイリアスを禁じる
  - `paths` はpackage.jsonの `exports` マップ検証をバイパスし、存在しないsubpath importがコンパイルを通って実行時の `ERR_PACKAGE_PATH_NOT_EXPORTED` で初めて発覚する
  - 代わりにProject References（参照先packageは `composite: true` と `declarationMap: true`）に一本化する
- 可能な場合は必ず `as const` を記述する
- TypeScriptファイルを直接実行する場合はNode.jsのstrip-typesを利用する
  - `ts-node`, `tsx` の利用を禁じる
  - ref: https://nodejs.org/docs/api/typescript.html

## Node.js CLI Tool Guidelines

Node.js CLIツールを作成する場合は以下に従う。

- ファイルの先頭に `#!/usr/bin/env node` を付与する
- 引数解析は `node:util` から `parseArgs` をインポートして利用し、手書きパーサは避ける
- TypeScriptで記述し、Node.jsのstrip-typesで実行する
- subprocess、artifact出力、baseline比較、filesystem cleanup、外部review gateのいずれかを扱う場合は`fail-closed-automation` skillもloadし、そのsubprocess・artifact ownership・TOCTOU規則を適用する

### CLI用 package.json Template

`bin` は strip-types で直接実行する `.ts` ファイルを指す（`.js` へのビルドは行わない）。

```json
{
  "private": true,
  "type": "module",
  "bin": {
    "my-cli": "./bin/cli.ts"
  }
}
```

### CLI Entry Point Template (`bin/cli.ts`)

```typescript
#!/usr/bin/env node
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  options: {
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
    }
  },
  allowPositionals: true,
})

function showHelp() {
  console.log(`Usage: my-cli <command> [options]

Options:
  -h, --help  Show this help message`)
}

async function main() {
  if (values.help) {
    showHelp()
    return
  }
  // ここにメイン処理を実装する
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
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

## Mandatory Skill Enforcement

- このskillがloadされたら、変更した `.ts` / `.js` ファイルに対して完了前に `scripts/check.ts` を実行し、errorが0件になるまで修正すること
- 変更したファイルを完了前に再読し、このskillの禁止事項に違反していないか必ず確認すること。skillのlint設定が適用された場合はlintで判定できない項目(`as const`、型の再定義、テストの並列耐性、Date Handling、Scripting、package.json・tsconfig・npmの設定、Node.js CLI Tool Guidelines)を、project設定が使われた場合はこのSKILL.mdのguideline全体を確認対象とする。project設定が使われた場合、skillのlint設定でのみ定義されたルールは適用せず、projectのlint/format規約に従う
- skill違反が見つかった場合、その時点で未完了として扱い、説明や完了報告より先に修正すること
