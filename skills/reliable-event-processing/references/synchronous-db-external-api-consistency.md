# Synchronous DB + External API consistency

1つのHTTP requestでlocal databaseとidentity providerなどのremote systemの両方を変更するときに使うreferenceです。

## Compensationだけでは不十分な理由

`rowをlock → DB transactionを更新 → remote APIを呼ぶ → DBをcommit → successを返す` というsequenceには、少なくとも2つのambiguous boundaryがあります。

1. remote APIがmutationを適用した後にrequest contextがcancelされたりresponseが失われたりする可能性がある。errorが返ったからといってremote mutationが行われなかった証明にはならない。
2. `COMMIT` がdatabaseへ到達して成功していても、clientがacknowledgmentを受け取れない場合がある。commit errorは必ずしもrollbackを意味しない。

commit errorのたびにremote valueをblindly元へ戻すと、逆方向のinconsistencyを作る可能性があります。DBにはnew valueが入っているのにremote systemだけold valueへ戻るためです。request contextに紐づいたcompensation callはさらに弱く、request cancellation直後に即座に失敗する可能性があります。

## 最低限必要なsafe contract

- 必要なlocal commitの成功が確認できるまでsuccess responseを返さない。
- row lockとexternal callのdurationを明示的にboundedにする。
- best-effort compensationを使う場合は、request cancellationから切り離した新しいbounded contextで実行する。Goなら `context.WithoutCancel` + `context.WithTimeout` を使う。
- external response ambiguityとDB commit ambiguityをgeneric failureではなく、別々のdurable stateとして扱う。
- operation IDとold/new stateを十分に永続化し、staleなauthentication/session contextを信頼せずreconcileできるようにする。
- 実際のlocal/remote stateを読み、documented source of truthを選び、idempotentにretryし、terminal stateまたはoperator-visibleなdead-letter stateへ到達するdurable reconciliation pathを用意する。
- raw credentialやtokenをlogしない。reconciliation log中のPIIを最小化する。operation ID、state、age、attempt count、classified failureをlogする。

## Design choices

### Durable synchronous saga

最初のnon-atomic boundaryを越える前にdurable operation recordを作ります。user-visible pathはsynchronousに実行し、完了後にoperationをcompleteへmarkします。ambiguous outcomeはpendingのままworkerまたはscheduled reconcilerへ渡します。public APIをsynchronousのまま維持しつつeventual convergenceを保証できます。

### Transactional outbox / asynchronous operation

business mutationとoutbox eventをatomicに書いてcommitし、その後relay/workerがremote APIを呼びます。public contractがasynchronousなら `202 Accepted` を返すかoperation statusを公開します。durability boundaryは最も明確ですが、product/API semanticsが変わります。

### Best-effort compensation only

product ownerがresidual inconsistencyを明示的に受け入れ、review gateでそのexceptionを記録した場合だけ許容します。zero-inconsistency guaranteeとして説明することはできません。

## 必須test

- remote success後にlocal commitが失敗する。
- compensation前にrequest contextがcancelされるが、detached bounded compensationは実行される。
- remote mutationは適用されたがresponseがerror/timeoutとして返る。
- database commit acknowledgmentがlost/unknownになる。
- compensationが失敗し、その後durable reconciliationが実行される。
- 同じidentityに対するconcurrent updateをrow locking/idempotency下で処理する。
- reconcilerのretry、deduplication、terminal failure visibility、PII-safe logを確認する。
- documented consistency boundaryを越えた後だけsuccess responseが返される。

## Review時の注意

review findingを暗黙のoutbox/worker architecture変更へ変換しないでください。新しいdurable execution boundaryを導入する場合は、実装前にspecification、failure-state model、operational contract、独立したadversarial reviewが必要です。
