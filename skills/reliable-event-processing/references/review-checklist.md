# Reliable event workflow review checklist

このchecklistはimplementation templateではなく、adversarial reviewの入力として使います。

## Producerとtransaction

- 実際のproducer runtimeはqueue bindingを直接呼べるか。呼べない場合、durable outboxはどこにあり、どのようにrelayされるか。
- 1つのdatabase transactionにbusiness state、idempotency result、outbox rowが含まれているか。
- trafficを受け入れる前に、local、CI、productionそれぞれでtransaction prerequisiteを確認しているか。
- 同じidempotency keyが同時到着した場合に何が起こるか。duplicate-keyとtransaction-conflictのhandlingを明示しているか。
- どのrequest componentをcanonical hashの対象にするか。effectに影響するmethod/path/query/body/header inputをすべて含めるか、禁止項目を明示しているか。
- response status、location、cookie headerのどれを永続化し、replayするか。

## Envelope、limit、ordering

- すべてのevent type、payload schema、許可されたdestination、callback route、runtime validation ruleを列挙しているか。
- stableなapplication `eventId` を持つversioned envelopeを定義しているか。providerのtransport IDで代用していないか。
- providerの現在の最大message bytes、batch bytes、batch count、retentionを確認しているか。business mutationをcommitする前にserialized sizeをpreflightしているか。
- synchronous workをboundedにしているか。event count、batch数、total deadline、per-call timeoutを定義し、partial batch sequence後のresponseも明示しているか。
- effectがorder-independentか明示しているか。そうでない場合、aggregate ordering key/versionとtransactional stale-event rejectionを含めているか。

## Recoveryとoperations

- atomicなowner/lease compare-and-setでclaimしているか。empty claim、leased、dispatchedのoperation stateを定義しているか。
- unresolvedなoutbox rowを自動deleteしていないか。durable terminal state到達後のrepair/quarantineとretentionを定義しているか。
- 許可されたDLQ/manual replay horizonに対してconsumer receipt retentionを定義しているか。
- DLQ source retentionを定義しているか。provider retentionが約束したre-drive期間より短い場合、acknowledgment前にvalidated envelopeを変更せずdurable archiveしているか。
- `eventId` を維持し、original envelopeをvalidateし、audit entryを記録し、malformed inputではmutationしないprotected re-drive methodを定義しているか。
- structured relay logとしてevent ID、operation ID、attempt、claim outcome、lease age、oldest pending age、failure category、countを出しているか。Dashboard/log queryとescalation thresholdもdocumentしているか。

## Proxyとrealtime boundary

- client-supplied internal/forwarding headerを除去し、trusted forwarding chainを1つ設定しているか。host、raw path/query、redirect、request abort、cookie、CORS、streaming behaviorを定義しているか。
- gateway policyがcommand classificationに依存する場合、classificationをexhaustiveかつversionedにしているか。body inspectionとstreamingが衝突するなら、method/path単位ですべてのrequestを保護する方を優先しているか。
- stableな `eventId` を保持するrealtime frame fieldを正確に定義し、すべてのreplay pathに対するpersistence/de-duplication horizonを明示しているか。

## Deterministic test

次をtestする: same-key race、transaction abort、direct publish rejection、accepted-send/failed-ack crash、lease expiry、duplicate delivery、stale ordering、callback five-retry/DLQ、archived manual re-drive、payload/count cap、missing index、unauthenticated internal call、proxy OAuth/cookie/CORS/SSE behavior、local/CIでのreplica-set startup。
