# Code review policy

このpolicyは `code-review` skillに紐づき、**いつ独立reviewを必須にするか** と **qualified reviewerの条件** を定義します。
reviewのseverity、input/output、finding adjudicationは同directoryの `../SKILL.md` を使います。

## Mandatory review

次のいずれかでは、独立したfresh contextのreviewを必須とします。

- 2ファイル以上を変更する実装・refactoring・bugfix
- commitまたはpushを伴うコード変更
- schema/query/auth/security/data-integrityに関わる変更
- 仕様または別policyが明示的にreviewを要求する変更

documentation-only / pure config-onlyで、ユーザーがverification skipを明示した場合は省略できます。ただし別のcontractでreview必須ならそちらを優先します。

## Reviewer qualification

- 実装者と同一の会話履歴を引き継がないfresh contextを使う。
- 可能なら実装モデルより高い能力tier、利用不能なら独立した同等tierを使う。
- capabilityの根拠が無いmodelを「新しい」「高価」「別provider」という理由だけで上位扱いしない。
- 必須tierを満たすreviewerが利用できない場合、qualified reviewを黙ってPASSにしない。状態を `Pending: qualified reviewer unavailable` とする。

## Reviewer route integrity

- qualified reviewerのprovider/modelは、ユーザーまたはrepositoryの適用policyから解決する。prompt中にモデル名を書いただけでは、そのrouteを選択した証拠にならない。
- dispatch wrapperがmodelを置換する可能性がある場合、完全なcandidateや長いreview contextを渡す前に、candidateを含めない小さなroute preflightを行う。実行リクエストにはqualified provider/modelを明示し、live dispatch metadataが一致するまで本レビューを開始しない。preflightできない場合は、route identityを保証できる直接経路を使う。
- live identityが欠落・曖昧・指定不一致なら、直ちに停止し `invalid reviewer identity` と記録する。candidateを調査させず、結果をVerdictやreview roundとして扱わず、発見事項をqualified evidenceに流用しない。
- 誤route後に許すのは、routeを明示的に修正したbounded retry 1回だけ。再びidentityを確認できない場合は `Pending: qualified reviewer unavailable/invalid identity` で止め、同じcandidateをdefaultまたはunqualified routeへ繰り返し送らない。
- 正しいqualified reviewerによるnon-PASSは別扱いとし、指摘をまとめてcanonical criteriaに照合する。確認済みのin-scope Blocking/Majorだけを修正し、変更後のcandidateに対してclosure reviewを行う。同一candidateを受け入れさせる目的で再レビューしない。review-cycle上限はcore skillの規則を使い、adapterごとに増やさない。

## Evidence

- 対象revisionを固定する。
- 実際に使われたreviewer/provider/modelまたはcapability tierを取得できるruntimeでは記録する。
- dispatchで指定したidentityと実行metadataの一致を確認し、route preflight・停止・retry状態を記録する。
- review後に対象revisionが変わった場合、古いreview evidenceを最終revisionのPASSとして再利用しない。
