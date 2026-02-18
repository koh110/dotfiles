---
name: development-react-activity
description: Reactコンポーネント実装時に適用する表示/非表示制御の規約。UIコンポーネントを書く際に自動的に参照される。
---

- コンポーネントの表示/非表示の制御は React の `Activity` コンポーネントを利用する
  - `<Activity mode={condition ? 'visible' : 'hidden'}>` パターンを使用する
  - `{condition && <Component />}` のような条件付きレンダリングではなく Activity を優先する
  - type が絞り込めないケース（例: `null` から non-null への型ナローイング）のみ Activity を以外の利用を許可する
  