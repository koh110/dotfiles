# テストサンプル

`SKILL.md` の Test Guidelines を満たす最小サンプル。新しいテストを書く際はこの構造を出発点にする。

## 基本構造

```ts
import { Prisma } from 'shared/src/prisma'
import { beforeAll, expect, test } from 'vitest'
import { createUserSeed } from '../test/seeds/index.js'
import { getTestDbClient, truncateTables } from '../test/utils.js'
import { addThing, listThing } from './handle.js'

let dbClient: Awaited<ReturnType<typeof getTestDbClient>>

beforeAll(async () => {
  dbClient = await getTestDbClient(process.env)
  await dbClient.$connect()
  // 接続と必要最小限の truncate のみ。seed はここで作らない。
  await truncateTables(dbClient, [Prisma.ModelName.user])
  return async () => {
    await dbClient.$disconnect()
  }
})

test('success listThing returns created records', async ({ task }) => {
  const prefix = task.id // ファイル内でユニーク。並列耐性の鍵。
  const seed = createUserSeed({ uid: 'USER_OK' }, prefix)
  await dbClient.user.create({ data: seed })

  const result = await listThing({ dbClient, query: {} })

  // count や length ではなく find() で自分のレコードのみを検証
  const found = result.users.find((e) => {
    return e.uid === seed.uid
  })
  expect(found).toBeDefined()
  expect(found?.name).toBe(seed.name)
})

test('error addThing - not found', async ({ task }) => {
  const prefix = task.id
  const _seed = createUserSeed({ uid: 'USER_NF' }, prefix)

  await expect(
    addThing({ dbClient, id: 99999999, requestBody: { foo: 'bar' } })
  ).rejects.toThrow(HTTPException)
})
```

## NGパターン

### グローバル prefix を共有する

```ts
// NG: 同一ファイルの全テストが衝突する
const PREFIX = 'sys_USER_handle'
test('a', async () => {
  await dbClient.user.create({ data: { uid: `${PREFIX}_001`, ... } })
})
test('b', async () => {
  // a の seed が残っているので状態が漏れる
})
```

`task.id` を毎テストで取り直し、それを prefix にする。

### `beforeAll` で seed を作る

```ts
// NG
beforeAll(async () => {
  await dbClient.user.createMany({ data: [...15 件...] })
})
test('listThing returns 15', async () => {
  const result = await listThing(...)
  expect(result.count).toBe(15) // 他テストが seed を足した瞬間に壊れる
})
```

`beforeAll` は接続と truncate のみ。データは各テスト内で作る。

### グローバルな state に依存した assertion

```ts
// NG: 他のテストが残したレコード次第で結果が変わる
expect(result.count).toBe(15)
expect(result.users).toHaveLength(15)
```

```ts
// OK: 自テストが作ったレコードだけを検証
for (const s of seed) {
  expect(
    result.users.find((e) => {
      return e.uid === s.uid
    })
  ).toBeDefined()
}
```

### 境界値テストのために PAGE_SIZE 超えのデータを投入

```ts
// NG: 遅い、かつ DB の他の状態に依存する
const bulk = Array.from({ length: 5010 }, ...)
await dbClient.user.createMany({ data: bulk })
expect(page1.users).toHaveLength(5000)
expect(page2.users).toHaveLength(25)
```

境界値そのものは省略するか、件数に依存しない代替で検証する。

```ts
// OK: skip が効くかどうかだけを確認 (件数非依存)
const result = await listThing({ dbClient, query: { page: 99999 } })
expect(result.users).toHaveLength(0)
```

### テスト内での `truncateTables`

```ts
// NG: beforeAll 以外で truncate しない
test('empty case', async () => {
  await truncateTables(dbClient, [...])
  ...
})
```

「空の状態」を検証したい場合は、検索条件で絶対にヒットしない値 (架空のID、未使用prefix) を使う。
