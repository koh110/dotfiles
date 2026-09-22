# Decision endpoint adapter pattern

Workerが人間承認付きのdecision endpointを公開している場合、文章上の `action=skip` 要件だけからwire formatを推測しないでください。まずprepared run/hashを使ったまま、side effectを発生させないschema probeを行い、validation errorから次を判別します。

- fieldごとに1 decisionなのか、entityごとに1 decisionなのか
- scalarなfield listなのか、`fields` recordなのか
- recommendation stateとfield action stateが別なのか

entity単位endpointで利用できる形の例です。

```json
{
  "proposalHash": "<run hash>",
  "decisions": [
    {
      "code": "<entity code>",
      "recommendation": "rejected",
      "fields": {
        "<updatable field>": {
          "action": "skip",
          "reason": "検証のため更新なし"
        }
      }
    }
  ]
}
```

recommendation enumやfield recordの形式はAPI固有なので、live validatorまたはproject contractから確認してください。重要な不変条件は、すべてのentityの `updatableFields` が表現され、すべてのfield actionが明示的に `skip` となり、proposed valueのkeyを送らないことです。

