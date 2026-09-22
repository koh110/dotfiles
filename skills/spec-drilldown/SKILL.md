---
name: spec-drilldown
description: '新規機能やarchitectureの実装前に、materialな曖昧さを解消し、実装可能なcanonical specificationを作るときに使う。明確なbugfixや既に十分な仕様があるtaskでは使わない。'
---

# Spec Drilldown

## Goal

実装結果を分岐させる曖昧さを解消し、**別のagent/modelへ渡しても同じacceptance criteriaを実装できるcanonical specification** を作ります。

このskillは仕様化のsemantic contractを定義します。いつ仕様を必須にするか、質問をどの程度積極的に行うか、どのreviewer tierを必須にするかはworking agreement/model profileの責務です。

## Workflow

1. **Known facts**: 依頼、既存コード、schema、関連docsから既に決まっていることを抽出する。
2. **Investigate**: repository、currentな公式資料、SDK/type、利用可能な実データを調べ、自分で解消できる未決事項を閉じる。
3. **Decision boundary**: reversibleな局所判断はassumptionとして明記できる。product/design/security/data semanticsなど、結果が長く残る複数案はユーザー決定として残す。
4. **Canonical spec**: Inputs/Outputs、Data Model、Interface、Error Handling、Non-functional Requirements、Out of Scope、Acceptance Criteria、Assumptionsを文書化する。
5. **Technical verification**: 外部service/API/runtime capabilityに依存する方式は、仕様へ固定する前に実現可能性を検証する。詳細は [references/technical-investigation.md](references/technical-investigation.md)。
6. **Adversarial review**: reviewが要求される場合、spec単体で実装できるかを独立contextで検査する。contractは [references/adversarial-review.md](references/adversarial-review.md)。
7. **Handoff**: material decisionとrequired reviewが閉じたcanonical specを実装入力にする。

## Question Categories

ユーザー判断が必要なときは、実装を分岐させる項目だけを質問します。

| カテゴリ | 決めること |
| --- | --- |
| 目的・ユーザー | 誰が何のために使うか、解決したい課題 |
| 入出力 | 入力形式、出力形式、具体例 |
| データ | data model、永続化、schema、既存dataとの関係 |
| 技術スタック | language、framework、runtime、外部service |
| Interface | UI flow、CLI command/flag、API contract |
| Failure | validation、retry、partial failure、recovery |
| Non-functional | performance、scale、authn/authz、concurrency |
| Scope | 今回やらないこと、将来対応 |

固定の質問数や往復回数をこのskillでは定義しません。調査で決まることをユーザーへ転送しないことを優先します。

## Exit Criteria

canonical specは少なくとも次を満たします。

- [ ] 入力と出力が具体例付きで定義されている
- [ ] 永続dataがある場合、data model/schemaが確定している
- [ ] 技術stackとruntimeが確定している
- [ ] 外部service/API/runtime capabilityのmaterialな前提が検証されている
- [ ] 主要なerror/edge caseの挙動が定義されている
- [ ] Out of Scopeが明記されている
- [ ] 検証可能なAcceptance Criteriaが列挙されている
- [ ] assumptionとユーザー決定が区別されている
- [ ] spec単体を別agent/modelへ渡しても、会話履歴から情報を補わず実装できる
- [ ] working agreementが要求するreview gateがある場合、その結果が追跡できる

## Spec Document

repositoryに慣習があれば従い、なければ `docs/spec/<slug>.md` を使います。

推奨構成:

- Overview
- Inputs & Outputs
- Data Model
- Tech Stack
- Interface
- Error Handling
- Non-functional Requirements
- Out of Scope
- Acceptance Criteria
- Assumptions
- Technical Investigation
- Adversarial Review（要求される場合）

実装中にmaterialな仕様変更が発生したら、会話内だけで処理せずcanonical specを更新します。

## Boundaries

- 未検証の外部API/service capabilityを既成事実として仕様へ固定しない。
- reviewerに会話履歴を渡してspecの欠落を補完させない。
- 調査で決まる事項を、agentが判断を避ける目的でユーザーへ質問しない。
- policy/model固有の質問回数、approval cadence、reviewer model名をこのskillへ追加しない。
