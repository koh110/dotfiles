# Skills の方針

`skills/` は、複数のagent runtimeで再利用できるskillのsource of truthです。

## 形式

移植性の基準として、open specificationである [Agent Skills](https://agentskills.io/) の `SKILL.md` 形式を使用します。

共通skillでは次の方針を守ります。

- `name` と `description` は特定runtimeに依存しない内容にする。
- frontmatterは標準のAgent Skillsフィールドを優先する。
- Hermes、Codex、Claude Code、Copilotなど、特定runtime専用のfrontmatter namespaceや記法を追加しない。
- runtime固有の配信、scheduler、tool、transport、installationの詳細は、共通のsemantic coreから分離する。
- portableに表現できないruntime固有の挙動は、対応するadapterや設定層に置く。
- referencesやscriptsはskill directoryからの相対pathで参照し、directory単位で自己完結して導入できるようにする。

最小構成のportableなskillは次の形です。

```markdown
---
name: example-skill
description: このskillが何を行い、どのような場合にagentが利用すべきかを記述する。
---

# Example Skill

対応するすべてのagentで共有する指示をここに記述する。
```

必要に応じて `license` などの標準optional fieldを使用できます。特定runtimeだけが理解できるという理由でmetadataを追加しないでください。

## Runtimeとの責務境界

共通skillは、再利用可能なworkflow、不変条件、domain knowledgeを定義します。runtime adapterは次のような詳細を担当します。

- skillのinstall先やdiscovery方法
- scheduler/jobの設定
- chat/threadへの配信方法
- runtime固有のtool名やpermission記法
- model/providerのpin方法
- platform固有のcommandやAPI

共通skillからruntimeの機能に触れる必要がある場合は、特定製品の記法を要求せず、「runtimeがjob単位のmodel選択をサポートする場合」のように機能を一般化して記述します。
