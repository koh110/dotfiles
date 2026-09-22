---
name: skill-feedback-criteria
description: '作業中に得た学びをskill、policy、runtime adapter、model profile、durable recordのどこへ反映するか判定するときに使う。'
---

# Guidance Feedback Criteria

## Goal

学びを「再利用できるか」だけでなく、**何に依存する知識か**で分類して正しいsource of truthへ反映する。

- `skills/`: task-specificなdomain knowledge / workflow contract
- `policies/`: taskをまたいで守らせるuser/repository working agreement
- `adapters/`: runtime/tool/platform固有のintegration
- `profiles/`: exact model固有のbehavior compensation
- durable record: incident、特定PR、時刻付き観測などの事案固有情報
- no-op: 自明、短命、重複、再利用価値なし

## Decision order

1. timestamp、log、特定PR/incidentなど事案固有ならdurable record。
2. installation path、tool名、permission、scheduler、transport等のruntime固有情報ならadapter。
3. exact modelだけの挙動差を補う指示ならprofile。根拠とexact identityが必要。
4. review必須条件、worktree運用、decision boundary等のcross-task working agreementならpolicy。
5. domain invariant、algorithm、task固有workflow/pitfall/verification contractならskill。
6. どこにも永続化する価値がなければno-op。

## Skill

Skillへ入れるもの:

- 特定種類のtaskで再利用される。
- model/runtimeが変わってもsemantic contentが変わらない。
- workflow、domain invariant、protocol、algorithm、task固有pitfallとして表現できる。
- skill directory単体で意味が完結する。

新しいskillを作る前に、既存skillのsection/reference追加で十分か確認する。root `SKILL.md` はtrigger/routerとして簡潔に保ち、詳細はreferences/scriptsへ分ける。

## Policy

Policyへ入れるもの:

- taskをまたいで守らせたい選好、品質基準、decision boundary。
- 「いつreview必須か」「dedicated worktreeを使うか」「どこまで自律判断してよいか」など。

Policyにはmodel名やruntime tool名を混ぜない。

## Adapter

Adapterへ入れるもの:

- instruction/skillのinstall・discovery方法
- runtime固有tool名、permission syntax
- scheduler/job、chat/thread delivery
- runtimeが作るworktree等の環境差
- model/provider pinのruntime-specific method

Portable contractの内容自体はadapterで変更しない。

## Model profile

Profileは次をすべて満たす場合だけ使う。

- exact model identityを特定できる。
- official guidanceまたは反復可能な観測根拠がある。
- 共通skill/policyへ入れると他modelへ悪影響があり得る。
- 小さなbehavior overlayとして表現できる。

同じprovider/familyという理由で近似profileへ流用しない。unknown modelはprofileなしをdefaultにする。

## Durable record

次はissue/comment/調査メモ等へ残す。

- timestamp付き観測値
- incident timeline
- 特定PR/issueだけの判断経緯
- 一時的なservice behavior
- screenshot/log excerpt

後から一般化できるpatternが見つかった時点で適切なlayerへ抽出する。

## Examples

- reviewのfinding schema → skill
- 2ファイル以上なら独立review必須 → policy
- 特定runtimeのlinked worktree path → adapter
- 特定modelでだけ不要なverification promptを減らす → profile
- 昨日のAPI障害ログ → durable record

## Common mistakes

- runtime固有path/toolをportable skillへ書く。
- modelの癖を全model共通policyへ昇格する。
- user/repository preferenceをdomain invariantとしてskillへ埋め込む。
- incident logをskillへ貼る。
- 同じsemantic ruleを複数layerへ重複コピーする。
- root `SKILL.md` を全知識のdumpにする。

## Completion

分類だけで終えず、選んだsource of truthを実際に更新する。

- skill → skill/reference/script
- policy → policy
- adapter → runtime adapter
- profile → exact model profile。根拠も残す
- durable record → issue/comment/調査メモ
- no-op → 重複または非再利用と判断した理由を短く残す

## Verification

- [ ] task / user-repo / runtime / exact model / incident のどれに依存するか分類した
- [ ] semantic ruleを複数layerへ重複させていない
- [ ] skillはmodel/runtime非依存で単体完結している
- [ ] policyにmodel/runtime固有情報が混ざっていない
- [ ] adapterはportable contractを変更していない
- [ ] profileにはexact identityと根拠がある
- [ ] source of truthを実際に更新した
