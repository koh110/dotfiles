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

## Root-level adapter

repository rootの `adapters/` は例外で、**runtime全体のdiscovery/deploy router** だけを置きます。

- skill directoryのinstall先
- skill-local policy/profile/adapterをどう発見するか
- global instruction入口への薄いrouter

task-specificなsemantic ruleはroot adapterへ持ち込みません。

## SKILL.md

移植性の基準として [Agent Skills](https://agentskills.io/) の `SKILL.md` 形式を使います。

- `name` / `description` は短く、何をするskillか・いつ使うかを明確にする。
- model名、provider固有の癖、runtime tool/pathをsemantic coreへ埋め込まない。
- root `SKILL.md` はrouter/contractとして保ち、詳細はreferences/scriptsへ分ける。
- skill-local policy/profile/adapterを参照する場合も、同一directory内のrelative pathで完結させる。

## Overlay rules

- `policies/default.md` はそのskillを利用するときのlocal working agreement。model/runtime名を含めない。
- `profiles/` はexact model identityが一致するときだけ読む。unknown modelではprofileなし。
- `adapters/` はruntime固有のtool/path/integrationだけを扱い、`SKILL.md` のsemantic contractを変更しない。
- 同じruleをSKILL/policy/profile/adapterへ重複コピーしない。
- incidentや特定PRの時系列はskill packageへ入れず、issue/comment等のdurable recordへ残す。
