# Model profiles

`profiles/` は、特定modelでのみ観測・documentされている挙動差を補正する **optional overlay** です。

## Rules

- exact model identityが分かり、対応profileが存在するときだけ適用する。
- model familyやproviderが同じという理由で近似profileを適用しない。
- profileは `skills/` のdomain contractや `policies/` のdecision boundaryを変更しない。
- profileにはmodelの一時的な弱点・過剰傾向を補う最小限の指示だけを書く。
- modelの更新で不要になった指示は削除する。

未知のmodelでは **profileなし** をdefaultにします。
