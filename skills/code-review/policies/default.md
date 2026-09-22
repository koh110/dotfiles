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

## Evidence

- 対象revisionを固定する。
- 実際に使われたreviewer/modelまたはcapability tierを取得できるruntimeでは記録する。
- review後に対象revisionが変わった場合、古いreview evidenceを最終revisionのPASSとして再利用しない。
