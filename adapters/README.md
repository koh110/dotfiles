# Runtime adapters

rootの `adapters/` は、skill package群を各runtimeのinstruction discoveryへ接続する **global routerだけ** を置きます。

task-specificなpolicy/profile/runtime差分は原則として各 `skills/<name>/` 配下に置きます。

root adapterの責務:

- skill packageのinstall/discovery方法
- skill-local `policies/` / `profiles/` / `adapters/` の読み分け
- runtimeのglobal instruction入口
- runtime全体にしか存在しないpermission/tool設定

root adapterはskillのsemantic contractやpolicyを複製しません。
