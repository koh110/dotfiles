---
name: reliable-event-processing
description: Queue、broker、worker、outbox、retry、DLQ、provider batch、consumer callbackを使う信頼性の高い非同期event/batch workflowを設計・review・migrationするときに使う。delivery guarantee、producer execution boundary、idempotency、transactionality、relay recovery、event-driven realtime、durable resumeやusage limitを伴う大規模LLM inferenceも対象とする。
license: MIT
---

# Reliable Event Processing

## 概要

database mutationによって最終的にexternal asynchronous effectを発生させるdistributed event workflowで使います。また、databaseとexternal APIの両方を1 requestで変更する、見かけ上synchronousなworkflowにも使います。queueがまだ存在しなくても、request cancellation、ambiguousなexternal response、database commit結果不明はdistributed consistency problemです。

## 使用条件

- producer、relay、worker、broker、queue、outbox、callback、DLQのいずれかがprocess/service boundaryをまたぐ。
- database mutationとexternal side effectを、retry、crash、ambiguous responseの下でも最終的に収束させる必要がある。
- batchやLLM workflowでdurable resume、idempotency、usage limit、operator recoveryが必要である。

永続化やexternal boundaryを持たない純粋なlocal in-memory operationには使わず、より単純なimplementation workflowを使ってください。

大量LLM Map/Reduce、repository analysis、model tiering、provider batch API、content-addressed result reuse、subscription/API usage limitの分類については `references/llm-batch-inference.md` を参照してください。

synchronous DB + external APIのfailure matrixとdurable convergence要件については `references/synchronous-db-external-api-consistency.md` を参照してください。

## 必須workflow

1. code変更前に、すべてのproducer、mutation boundary、event type、consumer、callback、retry path、human recovery pathをmapする。
2. providerの現在のofficial documentationから、limitとsemanticsを確認する。producer binding/API availability、acknowledgment behavior、message/batchの最大byte/count、retention、retry/DLQ behavior、local development上の差異、observability supportを含める。
3. queue workflowをdeployする前に、consumerが必要とするすべてのdownstream source（origin URL、authentication/WAF path、content type、size limit）をboundedなread-only probeで確認する。producer/consumerのdeploy成功だけではconsumerがsourceへ到達できることは証明できない。
4. producer contractを1つ選び明文化する。serviceがqueue bindingを直接利用できない場合、unreliableなHTTP bridgeをpublisher abstractionの後ろへ隠さない。durable outboxとrelay semanticsを定義する。
5. business mutation、operation idempotency record、outbox insertionをatomicにする。production、local development、CIで実際に必要なtransaction prerequisiteを満たす。
6. 実装前に、すべてのevent typeについて完全なversioned wire envelopeと正確なruntime schemaを書く。event ID、destination、operation ID、payload、ordering metadata、serialization/size limitを含める。
7. queue publication、claim/lease、acknowledgment、retry、callback、DLQ archive/re-drive、observability、operator runbookのcontractを明示する。「安全にretryする」のような曖昧な文章だけに依存しない。
8. 実装前に独立したadversarial reviewを行う。仕様全体のgateには `spec-drilldown` を使う。

## Materialized read-model publication

eventからJSON/HTMLのread modelを生成する場合、immutable revision publication、manifest CAS、source ordering、unpublish tombstoneを別個のconsistency contractとして扱います。publisher CLIが動作するだけでは、outbox/scheduler stageがscope外のままならsource mutation → eventual publicationの信頼性を証明できません。このpatternを実装・reviewする前に `references/materialized-read-model-publication.md` を参照してください。

## 必ず守る不変条件

- stableなapplication event IDを使い、transport message IDをbusiness idempotency keyとして使わない。
- producerがacceptした後にoutbox acknowledgmentが失敗した場合は、duplicateが起こり得るunknown-result caseとして扱う。consumer側で安全にdeduplicateする。
- atomicなcompare-and-set owner/expiry predicateでleaseをclaimする。同じownerがleaseを保持している場合だけacknowledgeする。
- documentedなdurable terminal stateへ到達していないoutbox eventをTTL deleteしない。
- consumer idempotency receiptは、許可されているすべてのreplay horizon以上保持する。manual replayに上限がないならnon-expiring receiptを使う。
- success response ruleは `all dispatched` と `leased by another publisher` を区別する。bounded wait終了時はdeterministicなretryable responseを返す。
- すべてのinternal callbackとmanual re-drive endpointに、正確なauthenticated method、payload schema、timeout、success status、rejection behaviorを定義する。
- direct producer failureとrelay failureを、operation/event ID、age/count fieldを含むstructured logとして記録する。repair endpointがあるだけではmonitoringにならない。

## Review checklist

実装前に `references/review-checklist.md` を読み、適用可能な項目をすべてspecで回答するか、recovery contract付きでscope外と明示します。

## Testing gate

transaction rollback、same-key concurrency、unknown producer result、lease expiry、duplicate queue delivery、callback retry/DLQ、manual re-driveでのidentity維持、oversized event rejection、proxy/auth rejection、設定したlocal/CI transaction topologyについてdeterministicなtest/harnessを要求します。

root authenticationを有効にしたMongoDB transaction topologyでは [references/mongodb-replica-set-test-topology.md](references/mongodb-replica-set-test-topology.md) を参照してください。特にauthorizationとreplica setを併用する場合はkeyfileが必要であり、readiness loopには上限を設け、integration test前にwritable-primary stateを確認する必要があります。

## よくある問題

- producerのsuccess responseを、durable eventがacceptされrecoverableになった証明として扱う。
- transport message IDやtimestampをbusiness idempotency keyとして使う。
- consumer receipt等のdeduplication boundaryなしにat-least-once deliveryをexactly-onceと説明する。
- operation identityとreconciliation stateを記録せずambiguousなexternal outcomeをretryする。
- local mockやunit suiteだけでprovider limit、transaction topology、callback reachability、source authenticationを確認できたとみなす。

## 検証checklist

- [ ] すべてのproducer、mutation boundary、event type、consumer、callback、retry、DLQ、operator pathがmapされている。
- [ ] business mutation、idempotency record、outbox insertionがdocumented atomic boundaryを共有している。
- [ ] envelope schema、size limit、ordering rule、lease semantics、acknowledgment behaviorがversion管理されtestされている。
- [ ] unknown producer resultとduplicate deliveryに明示的なrecovery behaviorがある。
- [ ] re-drive identity、auth/method/status contract、receipt retentionを確認している。
- [ ] local/CI transaction topologyとprovider/sourceのread-only probeを独立して確認している。
- [ ] 実装開始前に独立adversarial reviewが完了している。
