# Skills の方針

`skills/` は、複数のagent runtime・modelで再利用できる **task-specificな知識とworkflow contract** のsource of truthです。

## Guidance layer

agent向けの永続的な指示を、次の4層に分離します。

| Layer | 役割 | model/runtime依存 |
| --- | --- | --- |
| `skills/` | domain knowledge、workflow、不変条件、検証contract | 依存させない |
| `policies/` | 個人・repositoryとして常時守らせたい開発方針 | modelには依存させない |
| `adapters/` | runtimeのinstruction discovery、tool、permission、deliveryへの変換 | runtime依存 |
| `profiles/` | 特定modelの既知の挙動差だけを補正するoverlay | model依存 |

Skillへ「特定modelをうまく働かせるための矯正」を埋め込まないでください。別modelでは逆効果になり得ます。

## 形式

移植性の基準として、open specificationである [Agent Skills](https://agentskills.io/) の `SKILL.md` 形式を使用します。

共通skillでは次の方針を守ります。

- `name` と `description` は短くし、**何をするか**と**いつ使うか**を明確にする。
- frontmatterは標準のAgent Skillsフィールドを優先する。
- Hermes、Codex、Claude Code、Copilotなど、特定runtime専用のfrontmatter namespaceや記法を追加しない。
- model名、reasoning tier、provider固有の癖を補正する指示を入れない。
- runtime固有の配信、scheduler、tool、transport、installationの詳細を入れない。
- root `SKILL.md` は必要なworkflowを選べる最小routerに寄せ、詳細は同一skill directory内のreferences/scriptsへprogressive disclosureする。
- referencesやscriptsはskill directoryからの相対pathで参照し、**skill directory単体で意味が完結する**ようにする。

最小構成:

```markdown
---
name: example-skill
description: 何を行い、どのtaskで利用するかを短く記述する。
---

# Example Skill

このworkflowに固有で、model/runtimeをまたいでも変わらない知識とcontractを書く。
```

## Skillに入れないもの

次は原則としてskillから分離します。

- 「2ファイル以上なら必ずreview」など、個人・teamの運用判断 → `policies/`
- 「必ず毎回全testを回す」「質問は最大N問」など、modelの挙動を矯正するための指示 → 必要なら `profiles/`
- Claude Codeのworktree path、Codexのpermission記法、scheduler/chat delivery → `adapters/`
- 時刻・障害ログ・特定PRの判断履歴 → issue/comment等のdurable record

## Runtimeとの責務境界

runtime adapterは次を担当します。

- common policyをruntimeの常時instruction入口へ接続する
- skillのinstall先やdiscovery方法
- model profileのexact-match選択
- scheduler/job、chat/thread delivery
- runtime固有のtool名・permission記法
- model/providerのpin方法
- platform固有のcommandやAPI

adapterはskillやpolicyのsemantic contractを変更せず、runtimeの実行手段へ変換します。
