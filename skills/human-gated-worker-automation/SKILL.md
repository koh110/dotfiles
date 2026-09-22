---
name: human-gated-worker-automation
description: AgentがWorker/APIから情報を取得し、更新案を人間に確認してもらい、承認された変更だけを永続化する自動化を設計するときに使う。prepare-confirm-apply API、confidenceの扱い、entity単位の部分成功、冪等性、snapshot、modelとWorkerの責務境界を扱う。
license: MIT
---

# Human-gated Worker Automation

## 発火条件

次の要素を組み合わせるtaskでこのskillを使います。

- scheduled LLM agentやchat workflow
- data取得と永続化を担当するWorker/serverless API
- recommendation、direction、classification、prioritizationなど、modelによる意味的な判断
- side effect実行前の人間レビュー
- staleまたはpartialなdataによって既存の正しい値を破壊する可能性があるrecord更新

これは特定のrepository、asset type、chat platform、model providerに限定されない、設計パターンとしてのskillです。

## 基本となる責務境界

durableなdomain contractはWorker/APIに置き、会話上のorchestrationはagentまたは同等のruntimeに置きます。

| 責務 | Worker/API | Agent/model/chat |
| --- | --- | --- |
| authoritative dataからのcandidate選定 | Yes | No |
| external source取得とsource timestamp管理 | Yes | No |
| 明示されたformulaによるdeterministic calculation | Yes | No |
| durableなrun/proposal state | Yes | No |
| input schemaとvalue validation | Yes | No |
| semantic interpretationとrecommendation | No、validationのみ | Yes |
| 人間向けの説明とconfirmation | No | Yes |
| apply requestのorchestration | validateしてpersist | confirmation後に開始 |

Worker APIでvalidation、authentication、idempotency、audit policyを強制できるなら、agentにdatabaseへの直接accessを与えないでください。

## 必須lifecycle: prepare → confirm → apply

1. **Prepare**
   - 名前付きsnapshot/versionからboundedなcandidate setを選ぶ。
   - Workerで現在値を読み、source dataを取得する。
   - 曖昧さのないformulaだけをWorkerで計算する。
   - modelにreasoningさせる前にrun/proposal snapshotを永続化する。
   - stableな `runId`、`proposalHash`、`expiresAt`、source metadata、現在値、model inputを返す。

2. **Model decision**
   - write contractとしてfree-form textではなくstructured JSONを要求する。
   - 必要に応じてfield単位の `action`（`update` / `skip`）、proposed value、reason、confidenceを含める。
   - model outputはuntrusted inputとして扱い、Worker boundaryでvalidateする。
   - modelの不確実性は、empty stringや推測値ではなく、理由付きの `skip` として明示する。

3. **Confirm**
   - before/after、source、reason、confidenceを、会話を継続できるchat thread/sessionで人間に提示する。
   - proposal/recommendationはcanonicalなresearch/value tableへ混ぜず、専用のrecommendation/proposal tableへ保存する。
   - apply前に人間がreviewする場合、confidenceは参考情報であり、ユーザーが明示的に要求しない限り自動reject thresholdにはしない。
   - confirmationでは、承認対象となる正確な `runId`、proposal hash、entity setを特定する。

4. **Apply**
   - authentication、正しいrun state、未expireのproposal、hash一致、許可されたentity ID、schema-validなdecisionを必須にする。
   - `update` と明示されたfieldだけを更新する。`skip`、rejected、missing、invalid、unavailableなfieldは変更しない。
   - data取得やreasoningに失敗した場合は既存値を維持する。取得不能をempty string overwriteへ変換しない。
   - run/proposal identityによってoperationを冪等にする。

## Data model

最低限、次を永続化します。

- run/proposal identityとstatus（`prepared`、`confirmed`、`applied`、`expired`、`failed`）
- source snapshot timestampとsource reference
- before valueとproposed value
- proposal hashとexpiration
- model decision JSON、reason、confidence
- human decision JSONとconfirmation timestamp
- entity単位のapply statusとerror
- applied timestampとrun identity

semantic recommendation stateがraw research metricやcanonical valueと別概念なら、専用tableへ保存してください。既存columnがあるという理由だけで、`up/down/stay` をnumeric/text metric columnへ保存しないでください。

## Partial failureとtransaction scope

transaction boundaryを明示的に決めます。entity単位のpartial successが要件なら、次を満たします。

- entityごとに独立したtransactionで処理する。
- entityごとのsuccess/failureを記録する。
- 1 entityが失敗しても他entityを継続する。
- すでにapply済みのentityへ安全にretryできるようにする。
- 成功したentity IDと失敗したentity IDの両方をreportする。

entity単位の適用を選んだのに、all-or-nothing semanticsとして説明しないでください。

## Schedulingとsnapshot ordering

朝のprepareが、その日の後半に更新されるdaily rankingやcatalogを利用する場合は次を守ります。

- source snapshot refreshは、ユーザーが定めたdaily cutoffより後にscheduleする。
- prepareはsnapshot完成後、一般には翌朝にscheduleする。
- timezoneを明記し、cron expressionを書く前にplatformが実際に使うtimezoneへ変換する。
- source refreshとprepareを同時刻にしない。
- runとuser-facing reportにsnapshotの `fetchedAt` を含める。

既存のsource refreshと新しいprepare flowが同じscheduleを共有している場合は、時刻を変更するか、明示的なgeneration/version barrierを追加してください。偶然のtimingに依存しないでください。

## Runtime integration boundary

このskillはprepare → decision → confirm → applyのdomain contractを定義します。scheduler/job、session/thread継続、model/provider pin、duplicate message handling、runtime固有tool/permissionはadapterの責務です。

runtime integrationでは、次のcapabilityが必要かだけをdomain側から宣言します。

- human confirmationを受け取れる継続可能なinteraction
- approved run/proposal identityをapplyへ引き渡せること
- authentication secretをmodel outputへ露出せずWorker/APIを呼べること
- structured decision contractを保持できること
- partial success/failureをuser-visibleにreportできること

## Decision endpoint contract

Worker contractがentity単位のrecommendation stateとfield単位のactionを分離している場合は、entityごとに1つのdecision objectを構築します。各 `updatableFields` を `fields` recordで表し、そのnested actionを理由付きの `skip` として明示します。endpoint contractが明示的に要求しない限り、`{field, action}` のflat listを送らないでください。skipするfieldにproposed valueを含めないでください。candidate messageをpostする前にlive response contractをvalidateします。再利用可能なschema probeとadapterの詳細は [`references/decision-endpoint-adapter.md`](references/decision-endpoint-adapter.md) を参照してください。


## よくある問題

- field単位のskip semanticsが必要なのにfull-replacement PUT/POSTを再利用する。
- omitted fieldを `''` にnormalizeするupsertへ、`code` だけまたはpartial objectだけを送る。
- modelにcandidate選択やauthoritative data取得を任せ、scopeが再現不能になる。
- 人間reviewが要件なのにconfidenceをconfirmationの代わりに使う。
- recommendationをcanonical metrics tableへ保存し、auditやrollbackを曖昧にする。
- entity単位の継続を選んだのに全entityを1 transactionでapplyする。
- run hash、expiry、snapshot identityなしで `code` だけを使ってproposalをapplyする。
- schedulerのtimezoneを確認せずcron expressionがlocal timeだと仮定する。
- child processのexit codeだけでreview成功と判断する。実際のmodel identity、structured verdict、target revisionを確認する。

## 検証checklist

実装承認前に次を確認します。

- [ ] candidate selectionがdeterministicかつboundedである。
- [ ] source value、source timestamp、snapshot identityが永続化される。
- [ ] prepareとapplyが別API operationになっている。
- [ ] proposal state、hash、expiry、idempotencyが定義されている。
- [ ] structured model outputがschema validationされる。
- [ ] side effect前にhuman confirmationが必須である。
- [ ] `skip` が「変更なし」を意味し、empty-string overwriteにならない。
- [ ] 必要な場合、recommendation stateがcanonical metricsから分離されている。
- [ ] transaction scopeがpartial-failure要件と一致している。
- [ ] すべてのwrite pathでauthenticationが一貫している。
- [ ] cron timezoneとorderingが確認されている。
- [ ] stale proposal、duplicate apply、invalid decision、source failure、1 entity failure、partial success後のretryをtestしている。

## References

- 人間承認付きdaily ranked-data workflowの短い例は `references/portfolio-research-run-example.md` を参照する。
- specification-firstの質問とadversarial reviewには既存の `spec-drilldown` skillを使う。
- scheduler/chat/runtimeへの接続はadapter側で行う。このskillはdomain design contractだけを定義する。
