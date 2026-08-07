---
name: change-target-gate
description: 'TRIGGER when: 複数repositoryへの変更展開、skill・設定・artifactの配布、PR targetの決定、既存artifactのpatch/create判定、source of truth確認、manifest外差分の検証を行うとき。GitHub PRを作成する前に、repository ownershipと変更scopeをfail-closedで確認する。'
---

# Change Target Gate

## 目的

このskillは、agent固有の記憶やprovider固有のPR機能で変更先を決めず、repository内のportable CLIを使って変更targetを明示・検証するためのadapterです。

共通のsemantic coreは`tools/change-target-gate.mjs`にあり、agent側は次の入口を使います。

```bash
./bin/change-target-gate discover --repo . --query '<artifact or responsibility>'
./bin/change-target-gate verify \
  --repo . \
  --policy config/change-target-policy.json \
  --manifest path/to/change-target-manifest.json
```

## 必須手順

1. 変更を始める前に、target repository、owner、base branch、target path、operation（`patch`または`create`）をmanifestへ書く。
2. `discover`を実行して、target repositoryのsource of truthと既存artifactを確認する。
3. 既存artifactがある場合は`patch`、存在しない新規責務だけ`create`とする。mirrorやinstalled copyだけをsource of truthとして扱わない。
4. `verify`でrepository remote、policy、base、manifest、actual diffを検証する。
5. `verify`が成功するまで、push・PR作成・外部repositoryへのfeedbackを行わない。
6. PR作成後は、PRのowner/repository、base、head、commit SHA、changed files、stateを再確認する。

## Fail-closed条件

次の場合は変更・push・PR作成を停止します。

- manifestにtarget repositoryがない
- origin remoteとmanifestのrepositoryが一致しない
- policyで許可されていないrepositoryをtargetにしている
- base branchが一致しない、またはsource of truthが確認できない
- 既存artifactがあるのに`create`を指定している
- manifestにないpathが差分へ含まれている
- target外のtracked / staged / unstaged / untracked fileが存在する
- 複数の候補があり、ownerまたはsource of truthを一意に決められない

失敗を無視して直接`gh pr create`へfallbackしてはいけません。

## Portable利用上の注意

- Hermes、Codex、Claude、OpenCodeなどのagent名をCLIの判断材料にしない。
- installed skill mirrorを直接編集せず、owner repositoryのsource of truthを更新してから各agentへ同期する。
- `config/change-target-manifest.example.json`はschema例であり、実作業ではtargetごとのmanifestを作成する。
- 複数repositoryへ展開する場合はtargetごとに独立したmanifest・branch・PRとし、未計画repositoryを暗黙に追加しない。

## 完了条件

- `discover`の結果でsource of truthと既存artifactを説明できる
- `verify`が成功している
- `git diff --check`と対象skill/CLIのテストが成功している
- PR metadataとchanged filesがmanifestと一致している
- 作業用worktree・local branch・serverなどのcleanup状態を確認している
