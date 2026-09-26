---
name: skill-feedback-criteria
description: '作業中に得た学びをskill package内のcore/policy/profile/adapter、durable recordのどこへ反映するか判定するときに使う。'
---

# Guidance Feedback Criteria

## Goal

学びを「再利用できるか」だけでなく、**何に依存する知識か**で分類し、関連するskill package内の正しい場所へ反映します。

```text
skills/<name>/
  SKILL.md
  policies/
  profiles/
  adapters/
  references/
  scripts/
```

## Decision order

1. timestamp、log、特定PR/incidentなど事案固有 → durable record
2. 特定runtime/tool/pathだけに依存 → 対象skillの `adapters/`
3. exact modelだけの挙動差 → 対象skillの `profiles/`
4. そのskillを使うときのuser/repository working agreement → 対象skillの `policies/`
5. model/runtime非依存のdomain invariant/workflow contract → `SKILL.md` / `references/` / `scripts/`
6. 自明、短命、重複 → no-op

## Core skill

`SKILL.md` / references / scriptsへ入れるもの:

- model/runtimeが変わっても意味が変わらない
- domain invariant、protocol、algorithm、task-specific workflow/pitfall
- skill directory単体で意味が完結する

root `SKILL.md` はtrigger/routerとして簡潔にし、詳細はreferences/scriptsへ分けます。

## Policy

`skills/<name>/policies/` へ入れるもの:

- そのskillを利用するときに適用するuser/repository preference
- quality threshold、decision boundary、mandatory gate
- 例: code-reviewで2ファイル以上をreview必須にする、git-workflowでdedicated worktreeを使う

model名やruntime tool名は入れません。

## Adapter

`skills/<name>/adapters/` へ入れるもの:

- runtime固有tool/path/permission
- runtimeが作るworktree等の環境差
- scheduler/chat delivery等、そのskillに固有のruntime integration

deploymentはskill package内部を解釈せず、`skills/` を `~/.agents/skills` のmaterialized snapshotへ配布する。runtime adapterの選択は各 `SKILL.md` のpackage-local規約で行い、runtime別install差分はdeploy層に限定する。

## Model profile

`skills/<name>/profiles/` は次をすべて満たす場合だけ使います。

- exact model identityを特定できる
- official guidanceまたは反復可能な観測根拠がある
- core/policyへ入れると他modelへ悪影響があり得る
- 小さなoverlayとして表現できる

unknown modelではprofileなしをdefaultにします。

## Durable record

incident timeline、特定PRの経緯、一時的service behavior、timestamp付き観測はissue/comment/調査メモへ残します。
後から一般化できた時点で該当skill packageへ抽出します。

## Examples

- review finding schema → `code-review/SKILL.md`
- 2ファイル以上ならreview必須 → `code-review/policies/default.md`
- Claude Codeのworktree path → `git-workflow/adapters/claude-code.md`
- Astraでspec質問を過剰に増やさない → `spec-drilldown/profiles/openai/gpt-6-astra.md`
- 特定APIの一時障害 → durable record

## Completion

分類だけで終えず、選んだsource of truthを実際に更新します。

## Verification

- [ ] 対象skillを特定した
- [ ] core / policy / runtime / exact model / incident のどれに依存するか分類した
- [ ] 同じsemantic ruleを複数layerへ重複させていない
- [ ] skill directory単体で関連overlayまで持ち運べる
- [ ] adapter本文のsource of truthが対象skill directory内にあり、deploy scriptにはinstall/discovery上必要なruntime差分だけがある
- [ ] profileにはexact model identityと根拠がある
