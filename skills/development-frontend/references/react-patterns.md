# React パターン集（NG / OK）

`SKILL.md` の React / React Hook Form Guidelines を満たす具体例。実装前に該当パターンを確認する。

## Activity による表示/非表示

```tsx
import { Activity } from 'react' // React 19.2+

// NG: 条件付きレンダリング（stateとDOMが破棄される）
{isOpen && <DetailPanel item={item} />}

// OK: Activity で表示/非表示を切り替える
<Activity mode={isOpen ? 'visible' : 'hidden'}>
  <DetailPanel item={item} />
</Activity>
```

例外が2つある:

```tsx
// 例外1: 型ナローイングが必要な場合のみ条件付きレンダリングを許可
{selectedItem !== null && <DetailPanel item={selectedItem} />}

// 例外2: プロジェクトの react が Activity 未対応（< 19.2）の場合は
// 条件付きレンダリングを使用する（存在しないAPIを使ってbuildを壊さない）
```

## useEffect を変更検知に使わない

```tsx
// NG: props/state の変更検知で別の state を同期する
const [filtered, setFiltered] = useState<Item[]>([])
useEffect(() => {
  setFiltered(items.filter((item) => {
    return item.active
  }))
}, [items])

// OK: レンダー中に導出する（stateにしない）
const filtered = items.filter((item) => {
  return item.active
})
```

```tsx
// NG: 値の変更を監視して子の状態をリセットする
useEffect(() => {
  setFormValues(initialValues)
}, [userId])

// OK: key を変更して再マウントする
<UserForm key={userId} defaultValues={initialValues} />
```

## useEffect で API call しない

```tsx
// NG: マウント時のデータ取得を useEffect で行う
useEffect(() => {
  fetchUsers().then(setUsers)
}, [])
```

```tsx
// OK: GET は Server Actions（actions.ts）でサーバーサイド取得し、propsで渡す
// page.tsx (Server Component)
const result = await getUsers()
return <UserList users={result.value} />
```

```tsx
// OK: ユーザー操作起点の取得はイベントハンドラ内で行う
async function handleSearch() {
  const result = await searchUsers(query)
  setResults(result)
}
```

## react-hook-form: register で直接バインドする

```tsx
// NG: watch + setValue による手動ハンドリング
const agree = watch('agree')
<input
  type="checkbox"
  checked={agree}
  onChange={(e) => {
    return setValue('agree', e.target.checked)
  }}
/>

// OK: register で直接バインド
<input type="checkbox" {...register('agree')} />
```

## checkbox 配列の defaultValues は string[] で定義する

```tsx
// DOM の value は常に string。number[] にすると checked 判定が壊れる
const { register, handleSubmit } = useForm({
  defaultValues: {
    organizationIds: [] as string[],
  },
})

function onSubmit(data: { organizationIds: string[] }) {
  // 数値が必要な場合は submit 時に変換する
  const ids = data.organizationIds.map(Number)
}
```

## リセットは key 更新による再マウントで行う

```tsx
// NG: reset() や value='' 制御でフォームを初期化する
reset()

// OK: key を更新してコンポーネントごと再マウントする
const [formKey, setFormKey] = useState(0)

<UserForm key={formKey} />

// リセットしたいタイミングで
setFormKey((current) => {
  return current + 1
})
```

## コンポーネントを map で描画する場合は {} と return を省略しない

```tsx
// NG
{users.map((user) => <UserRow key={user.id} user={user} />)}

// OK
{users.map((user) => {
  return <UserRow key={user.id} user={user} />
})}
```
