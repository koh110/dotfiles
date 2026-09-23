# Skills の方針

`skills/` は、複数のagent runtime・modelで再利用できるskill packageのsource of truthです。

## 1 skill = 1 portable package

policy / model profile / runtime adapterが **そのskillにだけ関係するなら、同じskill directoryへ置きます**。

```text
skills/<name>/
  SKILL.md
  policies/
    default.md
  profiles/
    openai/
      gpt-6-astra.md
  adapters/
    claude-code.md
  references/
  scripts/
```

この構造により、`skills/<name>/` directory単体を別runtimeへ持っていっても、そのskillに必要なsemantic core・working agreement・optional overlayをまとめて移せます。

### 責務

| Path | 役割 |
| --- | --- |
| `SKILL.md` | model/runtime非依存のdomain knowledge、workflow、contract |
| `policies/` | このskillを使うときのuser/repository working agreement |
| `profiles/` | exact model固有の最小behavior overlay |
| `adapters/` | このskillに固有のruntime integration差分 |
| `references/` | progressive disclosureする詳細知識 |
| `scripts/` | deterministicに実行できる補助tool |

## Deployment

Git repositoryの `skills/` はsource of truth、`~/.agents/skills` はruntime-visibleなinstalled snapshotとして分離します。

```text
dotfiles/skills/
      |
      | deploy: real file copy
      v
~/.agents/skills/
      |
      +-- Codex / Copilot: native discovery
      `-- Claude Code: ~/.claude/skills/<name> -> ~/.agents/skills/<name>
```

- sourceを直接symlinkせず、deploy時点のsnapshotを実ファイルとして配置する。
- dotfilesが管理するtop-level entryだけを更新し、`~/.agents/skills` に別途導入された第三者skillは残す。
- installed snapshotのhashをmanifestへ記録し、deploy後の手編集を次回deployで検出する。
- source側の更新は通常のdeployとして反映し、installed側だけ変更されている場合はfail-closedにする。
- Codex / Copilotの旧runtime別copyは退役させ、Claude Codeだけcompatibility symlinkを持つ。

deploymentはskill package内部のpolicy/profile/adapterの意味を解釈しません。読み分けは各 `SKILL.md` のpackage-local規約で行います。

## SKILL.md

移植性の基準として [Agent Skills](https://agentskills.io/) の `SKILL.md` 形式を使います。

- `name` / `description` は短く、何をするskillか・いつ使うかを明確にする。
- model名、provider固有の癖、runtime tool/pathをsemantic coreへ埋め込まない。
- root `SKILL.md` はrouter/contractとして保ち、詳細はreferences/scriptsへ分ける。
- skill-local policy/profile/adapterを参照する場合も、同一directory内のrelative pathで完結させる。
- `policies/default.md` は存在すればloadし、adapter/profileはcurrent runtime / exact modelに一致するものだけをloadする。

## Overlay rules

- `policies/default.md` はそのskillを利用するときのlocal working agreement。model/runtime名を含めない。
- `profiles/` はexact model identityが一致するときだけ読む。unknown modelではprofileなし。
- `adapters/` はruntime固有のtool/path/integrationだけを扱い、`SKILL.md` のsemantic contractを変更しない。
- 同じruleをSKILL/policy/profile/adapterへ重複コピーしない。
- incidentや特定PRの時系列はskill packageへ入れず、issue/comment等のdurable recordへ残す。
