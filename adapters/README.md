# Runtime adapters

`adapters/` はportableなskills/policies/model profilesを、各runtimeのinstruction discovery・tool・permissionへ接続する層です。

Adapterの責務:

- global policy routerをruntimeの常時instruction入口へ配置する
- task-specific skillはruntime標準のskill discoveryへ配置する
- exact model identityが分かる場合だけ一致する `profiles/` を参照させる
- runtime固有のtool名、permission、scheduler、chat delivery、model pinへ変換する

Adapterはsemantic contractを変更しません。

- reviewのseverityや合格条件をruntime都合で弱めない
- policyで必要なhuman decisionをmodel都合で自動化しない
- model profileを他modelへ流用しない
