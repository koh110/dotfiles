# Materialized read-model publication

mutableなsource of truth recordから、stableなread URLの背後に置くimmutableなJSON/HTML artifactを非同期生成するときに使うpatternです。

## Stageを分離する

outbox relayやschedulerを決める前にpublisher CLIだけを実装・検証することはできますが、それはpublication primitiveにすぎず、end-to-endのeventual-delivery guaranteeではありません。

次のcontractを分離して扱います。

1. source mutation → durable event/outbox
2. event claim/order/retry → publisher invocation
3. source snapshot → validated artifact
4. immutable artifact write → stable manifest switch
5. stable manifest → read-path rendering/cache

未実装stageは明示してください。stage 3〜5しか存在しないのに「post保存ごとに反映」と説明しないでください。

## Immutable revision + manifest switch

推奨key構成:

```text
records/{id}/revisions/sha256-{contentHash}/page.json
records/{id}/manifest.json
```

publication順序:

1. page JSONをvalidateしcanonical serializeする。
2. 実際に保存するbyte列そのものをhashする。
3. `If-None-Match: *` でrevision objectを作成する。すでに存在する場合はoverwriteせず、保存済みhash metadataを検証する。
4. current manifestとETagを読む。
5. source-version regressionをrejectする。
6. manifestが存在する場合は `If-Match: <etag>`、存在しない場合は `If-None-Match: *` で更新する。
7. precondition failure時は再読込して再評価する。同じwriteをblind retryしない。

manifestを最後のvisibility switchにしてください。revision uploadが失敗してもprevious manifestは変更されてはいけません。

## Source orderingをfirst-class fieldにする

`sourceModifiedAt`、source revision、outbox sequenceなど、source由来のordering valueを含めます。generation timeだけではorderingとして不十分です。retryやconcurrent workerは順不同で完了する可能性があります。

timestampで十分なのは、必要なresolutionでsource contractがmonotonic updateを保証する場合だけです。それ以外はdatabase revision/sequenceを使います。同じordering valueでcontentが異なる場合はconflictとしてfail closedします。

## Unpublish/delete

draftのpublishを拒否するだけでは、以前publish済みのartifactは取り消されません。明示的なtombstone manifestを定義します。

```json
{
  "schemaVersion": 1,
  "recordId": 123,
  "state": "unpublished",
  "sourceVersion": "...",
  "generatedAt": "..."
}
```

readerはproduct semanticsに従ってdeterministicに404/410を返し、古いrevisionへfallbackしません。古いimmutable objectは、別途設計したlifecycle policyで削除するまで残して構いません。

physical deletionはさらに難しくなります。source row削除後はordering valueを取得できない可能性があるためです。outbox/eventにrecord IDとsource sequenceを削除前に含めるか、deletion workflowがsource transaction内でdurable tombstoneを書く必要があります。publisher側でwall-clock timeからdeletion orderingを捏造しないでください。

## DB-less reconciliationを明示的な弱いcontractとして扱う

legacy databaseを変更しないために、product ownerがsource側のdirty/outbox stateを意図的に採用しない場合があります。この設計が有効なのは、弱いguaranteeを明示した場合だけです。immediate publicationはbest-effortであり、operatorまたはschedulerがfull reconciliationを完了した後に収束します。これをdurable event deliveryと説明しないでください。

fail-closedなreconciliation workflowを使います。

1. managed IDとpublication stateをすべて含む、完全でlightweightなsource inventoryを取得する。開始/終了時刻、件数、hashを記録する。partial scanはdeletion判断に使えない。
2. remote manifest inventoryを最後までpaginateし、削除candidateごとに実際のmanifestをvalidateする。list metadataやcache indexだけを信頼しない。
3. `source published - remote published` をpublish-needed、`remote published - source managed/published` をtombstone candidateとして計算する。双方を明示的なowner/prefix/ID namespaceへ限定する。
4. source snapshot開始時刻以降に生成されたobjectはconcurrentとみなしskipする。新しくpublishされたrecordをtombstoneするより、安全側のfalse negativeを選ぶ。
5. snapshot hash、candidate ETag、expiry、candidate-count guard、canonical plan hashを持つimmutable dry-run planを書く。streaming scan outputから直接deleteをapplyしない。
6. apply直前に各candidateについてsource existence/stateとcurrent manifest ETagを再確認する。変更があればskip/nonzero resultとし、fresh planを要求する。
7. tombstone manifestをpublishする。reconciliation中にimmutable revisionをphysical deleteしない。

大規模運用ではkeyset pagination、streaming NDJSON、bounded concurrency、atomic checkpoint、resumable reportを使います。rendered outputがtaxonomy、metadata、author record、template、plugin、filterなどにも依存する場合、record modified timestampだけを根拠にfull republishをskipしてはいけません。incomplete scan、duplicate ID、invalid manifest、cursor loop、count anomaly、expired plan、過剰なtombstone countを検出したら、destructive changeを一切行わないでください。

reconciliationのwall-clockはobservation runの識別には使えますが、元のdeletion orderの証明にはなりません。apply時のsource再確認とmanifest CASがsafety boundaryです。strict event orderingやbounded automatic recoveryが必要なら、このDB-less modeでは不十分です。durable source version/outbox設計へ戻してください。

## Reader validation

readerは次をvalidateします。

- bodyを読む前のmanifest/page size
- schema versionと正確なruntime schema
- request ID = manifest ID = page ID
- manifest artifact keyがID + revisionから再計算したkeyと一致すること
- pageの正確なbyte列のhashがmanifest hashと一致すること
- canonical URLなどsecurity-sensitiveなURLがallowlistに一致すること

`HEAD` やconditional `304` でも、`GET` と同じmanifest/revision selectionとintegrity checkを行います。`HEAD` をmanifest-only validationへ最適化しないでください。manifestだけを見て200/304を返すと、GETでは提供不能なmissing/corrupt revisionを隠す可能性があります。object metadataに信頼できるcontent hashがない場合、`HEAD` でも実際のrevision bytesを読みhashしてください。response bodyを省略するのはvalidation後です。

## Strict source exportとsanitization boundary

sourceがWordPressなどplugin-driven CMSの場合:

- application runtime経由でexportしてfilter/shortcodeを適用する。ただしexporterはread-onlyにし、live treeへprobe fileを置かずstdin経由でstreamする。
- bootstrap codeがwarningや無関係なstdoutを出す可能性があるため、machine-readable JSON lineには識別prefixを付ける。
- publisherでもexporter payloadを再validateする。exact schema、requested ID、publication state、canonical URL、source ordering、password/private exclusionを確認する。
- artifact publication前に `contentHtml` をsanitizeする。tag/attribute/protocol allowlistに加え、image/embedにはURL host/path policyも適用する。protocol filteringだけでは不十分。
- sanitizer functionだけでなくpersisted output bytesをtestする。representativeなlive fixtureを `script`、event attribute、`javascript:`、`srcdoc`、CSS `url()` についてscanし、content hashがmanifestと一致することも確認する。

## Verification ladder

unit testだけで終わらせず、boundaryごとにscopeを広げて検証します。

1. runtime schema/parser test、renderer escaping test、CAS/concurrency test
2. typecheckとpackaging/dry-run build
3. source runtimeのsyntax checkとreal public recordのread-only export
4. revision → manifestの順に書き、保存byteを再hashするfilesystem dry-run
5. isolated local object store + Worker E2EでGET、HEAD、conditional 304、tombstone、missing revision、hash mismatchを検証

local runtimeがfuture compatibility dateを拒否する場合は、まずpinned CLI/runtime packageをそのdateに対応させてください。古いlocal binaryを動かすためだけにproduction compatibility dateを弱めないでください。setup correction後にE2Eをやり直します。

## Failure policy

- broken/invalidなnew manifest: deterministicな5xxを返す。productがorigin-load amplificationを明示的に許容しない限りoriginへsilent fallbackしない。
- publication failure: last successful manifestを維持する。
- tombstone: republish latency contractに従ってのみcacheする。
- error response: storage key、stack trace、credential、artifact bodyを露出しない。

## Test matrix

- revision write failureでmanifestが変更されない
- newer sourceとのmanifest CAS conflictでstale workerをrejectする
- source versionが同じでcontentが異なる場合fail closedする
- identical revisionのretryがidempotentである
- tombstoneがpublished revisionをsupersedeする
- delayed publishがnewer tombstoneをsupersedeできない
- valid manifestの背後でrevisionがmissingな場合、GETとHEADが一貫してfailする
- hash/key/ID mismatchをrejectする
- artifact failure時にautomatic origin fallbackしない
