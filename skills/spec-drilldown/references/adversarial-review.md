# Adversarial specification review

このreferenceは、canonical specを独立contextでreviewする場合のportable contractです。**reviewを必須にする条件**と**reviewer qualification**は外部policyの責務です。

## Inputs

reviewerへ渡すのは原則として次だけです。

- ユーザーのcanonical requirement
- 対象Spec Document
- Acceptance / Exit Criteria
- 必要な技術検証source

会話履歴全体を渡してspecの欠落を補完させません。対象revisionまたは更新時点を記録します。

## Review focus

少なくとも次を確認します。

- 原要求の取りこぼし
- Inputs / Outputs
- data lifecycle
- failure / retry / partial failure / recovery
- authn / authz
- idempotency / concurrency / ordering
- performance / scale
- 外部APIの未検証前提
- Out of ScopeとAcceptance Criteriaの矛盾
- 検証不能なAcceptance Criteria
- 用語・state modelの不整合

## Finding schema

各findingにID、severity、該当箇所、failure scenario、必要なdecision/fixを含めます。

| Severity | 判定基準 |
| --- | --- |
| Blocking | 追加決定なしでは実装が一意に定まらない、または要求を満たせない |
| Major | acceptance、failure handling、technical feasibility、data integrity等のmaterialな欠落・矛盾 |
| Minor | 実装結果を左右しない補足・表現改善 |
| Invalid | canonical requirement、verified source、既存contractと矛盾する指摘 |

## Resolution

1. Blocking / Majorをcanonical requirementとverified factsに照らして判定する。
2. confirmedなBlocking / Majorはspecを修正する。
3. 調査で決まる事項は自律調査し、genuineなユーザーdecisionだけを残す。
4. 採用しないfindingはInvalidとした根拠を記録する。
5. 修正版をreviewし、要求されたgate条件を満たした結果をrevisionと結び付ける。

runtime固有のCLI、model pin、session作成、artifact保存方法はadapterへ分離します。
