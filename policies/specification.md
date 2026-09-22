# Specification policy

このpolicyは **いつ仕様化を必須にするか** を定義します。仕様書の構成・technical investigation・review schemaは `skills/spec-drilldown` のcontractを使います。

## Require a specification when

- 新規application、feature、CLI、API、主要UI flowを作る
- queue / stream / broker / event bus / job runnerを導入・置換する
- distributed lock、retry/backoff、DLQ、ack、consumer group等のfailure semanticsを変える
- runtime境界をまたぐ連携やdurable workflowを新設する
- product semanticsやdata lifecycleに複数の妥当な設計分岐が残る

明確なbugfix、小さなrefactoring、既にacceptance criteriaが十分具体的なtaskでは省略できます。

## Resolve ambiguity

未決事項は次の順で解消します。

1. repositoryと既存contractを調べる
2. currentな公式資料・schema・SDK・実データを確認する
3. reversibleで局所的なら明示的なassumptionとして進める
4. product/design/security/data semanticsなど、ユーザー決定が必要なものだけ質問する

固定の質問回数・往復回数はpolicyにしません。質問数ではなく、実装結果を分岐させる未決事項が残っているかで判断します。

## Approval

仕様が必要なtaskでは、materialなユーザー決定を反映し、要求されたreview gateを満たしたcanonical specを実装入力にします。
