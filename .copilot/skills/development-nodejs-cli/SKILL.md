---
name: development-nodejs-cli
description: Skills for building Node.js CLI tools.
---

- ファイルの先頭に `#!/usr/bin/env node` を付与する
- 引数解析は `node:util` から `parseArgs` をインポートして利用し、手書きパーサは避ける
  - `commander` などの利用は禁じる
- Node.jsのstrip-typesを利用し、TypeScriptで記述する
  - https://nodejs.org/docs/api/typescript.html
  - `ts-node`, `tsx` などの利用は禁じる

## package.json Template

```
{
  "private": true,
  "type": "module",
  "bin": {
    "my-cli": "./bin/cli.js"
  }
}
```

## Entry Point Template

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

## tsconfig.json Template

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