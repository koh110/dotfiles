# 信頼性の高いLLM batch inference

大量のrepo比較、分類、Map/Reduceなど、LLM requestを多数非同期実行するworkloadの設計指針。

## 制限を分類する

すべてを「rate limit」としてbackoffしない。

| 症状 | 意味 | 処理 |
|---|---|---|
| API `429` + `retry-after` | RPM/ITPM/OTPMの短時間制限 | headerに従いjitter付き再試行 |
| API `529` / overload | 一時的provider障害 | 上限付き指数backoff |
| subscription session/weekly limit | seat allowance exhaustion | resetまでdurable pause。連続retry禁止 |
| organization monthly spend limit | usage-credit cap | admin/billing判断。短時間retry禁止 |
| schema-invalid output | semantic failure | strict quarantineし、上限付きitem単位再実行 |

人間向けsubscriptionのrolling allowanceはchat等と共有され、残量・完了時刻を保証できない。数十件以上のproduction batchやSLA付きjobでは、専用budgetを持つAPI batchまたはcloud batch経路を使う。subscriptionからAPIへの自動fallbackは認証・課金境界を変えるため禁止し、providerを明示設定する。

## 消費量を減らす順序

1. **Incremental analysis**: 毎回full inputを送らず、変更されたsemantic packだけ再処理する。
2. **Content-addressed cache**: model ID、prompt/schema version、domain、sorted input hashesをcache keyへ含める。
3. **Stable semantic packs**: path順の可変長詰め込みだけに依存せず、ファイル追加で後続chunkが全面invalidateされないmodule/domain単位にする。
4. **Model tiering**: 局所Map・機械的統合は安価なmodel、全体最終判断だけ上位modelにする。既存上位model出力をgolden baselineとして層化A/B評価してから切り替える。
5. **Prompt caching**: instruction/schema/manifestを完全一致prefixに、変動dataをsuffixに置く。artifact cacheの代替ではない。
6. **Periodic full scan**: incremental runとは別に、model/prompt/schema変更時や定期監査でfull再評価する。

chunkを大きくしてcall数だけ減らしても、総入力tokenが同じならusageはほぼ改善しない。小さくしすぎると固定prompt overheadが増える。callsとinput/output tokensを別々に測る。

## Durable state machine

```text
prepared → budget_checked → submitted → collecting → validated
         → reduced → finalized → awaiting_approval → published
```

永続化するもの:

- run ID、source snapshot IDs、provider/model、prompt/schema version
- token estimateとbudget decision
- provider batch ID、requestごとのstable `custom_id`
- raw result、strict validation result、retry/quarantine reason
- reduce/finalize/publication status

batch全体ではなく失敗した`custom_id`だけ再投入する。provider側の結果保存期限を正本にせず、終了後すぐobject storageへ保存する。

## Artifact publicationとresume

- 正式raw artifactはCLI/API成功後だけatomic publishする。
- 再利用前にnon-emptyだけでなく、expected metadataとstrict schemaを再検証する。
- invalid artifactはcollectorのglob対象directory内でsuffix変更するだけではplan外outputに見える場合がある。専用quarantine directoryへ移す。
- duplicate submitとunknown resultを前提に、`custom_id`またはcontent hashで冪等化する。
- cache hit artifactも現在のmodel/prompt/schema/source snapshotとの一致を再検証する。

## Prompt cache

- static prefix末尾へ明示breakpointを置き、timestampやchunk metadataをprefixへ混ぜない。
- 並列requestでは最初のresponse開始前にcacheが使えないことがある。必要ならpre-warmしてからbatchをsubmitする。
- cache read/creation/uncached inputを分離して観測する。
- prompt cacheは短期rate-limit利用効率を改善するが、subscription allowanceをproduction capacityへ変えるものではない。

## 品質・capacity gate

最低限、以下を測定する。

- calls、input/output tokens、cache hit率、provider/model別費用
- manual resume回数、item retry回数、schema-valid率
- incremental cache hit率とfull scan比のtoken削減量
- cheap-model Mapの重要finding recall、hallucination率、final recommendation差分
- submit前budget拒否、spend cap超過0件、同一inputのdeterministic finalize一致

高品質modelから安価modelへ処理段階を移す際は、「それらしい出力」ではなく既存artifactに対する層化recall/precision gateで判断する。
