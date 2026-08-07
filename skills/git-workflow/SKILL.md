---
name: git-workflow
description: 'TRIGGER when: git repository で状態確認、branch 作成、差分確認、commit、rebase、push、worktree 作成、cleanup などの git 操作全般を行うとき。コード変更では既存の linked worktree を再利用し、root checkout にいる場合だけ repository root 配下の `.worktree/` に専用 worktree を作成して、編集・test・lint・build・commit を完結させる。'
---

## General Guidelines

- 最初に repository root、Git dir、common Git dir、branch、working tree、worktree 一覧を確認する
- repository root checkout を feature / fix / refactor / chore の継続的な作業場所として利用しない
- コード変更を伴う作業では、現在地が linked worktree ならその worktree を再利用し、root checkout なら専用 worktree を作成する
- linked worktree 内で新しい worktree を入れ子に作成しない
- `git status`, `git diff`, branch 名を確認せずに commit / rebase / push / cleanup を行わない
- destructive な git 操作は、対象 path と復元手段を確認してから実行する
- main checkout に feature 変更を残したまま完了扱いにしない

## Worktree Context Detection

Git 操作や編集を始める前に、以下を実行する。

```bash
repo_root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --path-format=absolute --git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
git branch --show-current
git status --short
git worktree list
```

- sessionが `.worktree/<name>/` 以下から起動されている場合も、repository root ではなく起動中の linked worktree を作業場所として扱う。`git_dir != common_dir` であることを確認できたら、共有 `.git` への書き込みを要する `git worktree add` は実行しない
- `git_dir != common_dir`: linked worktree 内にいる。agent、IDE、automation、または手動の Git 操作で作成された worktree を含む。作成元にかかわらず現在の worktree を専用作業場所として再利用し、新しい worktree を作成しない
- `git_dir == common_dir`: root checkout にいる。コード変更なら `.worktree/` 配下に専用 worktree を作成して移動する
- 判定結果と実際の `git worktree list` が矛盾する場合は編集を始めず、path 解決と Git 状態を再確認する

## Branch Guidelines

- branch 名は作業内容と一致させる
  - `feature/<short-name>`
  - `fix/<short-name>`
  - `chore/<short-name>`
- branch を切る前に現在 branch と working tree の状態を確認する
- dirty な root checkout を、そのまま正規の作業場所だとみなさない
- linked worktree が detached HEAD の場合、変更前に専用 branch を作ることを原則とする
- 利用中の agent やツールが detached HEAD のまま編集を開始する場合も、最初の commit より前に専用 branch を作る
- detached HEAD のまま commit / rebase / push を行わない

## Worktree Guidelines

- linked worktree 内にいる場合は、現在の worktree をそのタスクの専用作業場所として使う
- root checkout にいる場合だけ、repository root に `.worktree/` ディレクトリを配置し、その配下に専用 worktree を作る
- worktree 名と branch 名は作業内容に揃える
  - 例: `.worktree/feature-api-cache` = `feature/api-cache`
  - 例: `.worktree/fix-login-timeout` = `fix/login-timeout`
- test / lint / build / commit は作業中の worktree 内で実行する
- root checkout の `git status` に `.worktree/` が出る場合は、放置せず local exclude などで隠す
- 誤って root checkout で変更を始めた場合も、そのまま続けず worktree へ移植して root checkout を戻す

## Existing Linked Worktree Guidelines

- `git_dir != common_dir` なら `git worktree add` を実行しない
- 現在の worktree の path、branch、status を確認し、そのタスク専用として安全に利用できることを確認する
- 既に適切な専用 branch にいる場合は、その branch と worktree をそのまま使う
- detached HEAD で未変更なら、原則として編集前に専用 branch を作る
- detached HEAD で既に変更がある場合は変更を保持したまま専用 branch を作り、status と diff が維持されていることを確認する

```bash
git switch -c feature/short-name
git branch --show-current
git status --short
```

## Worktree Creation Guidelines

- この手順は `git_dir == common_dir` の root checkout にいる場合だけ実行する
- コード変更を伴う作業では、`git worktree list` と `git status --short` を確認してから worktree を作る
- repository root に `.worktree/` がなければ作る
- PRを作成する場合は、先にPRのtarget/base branchを確定する。明示された既存branchを優先し、未指定ならremoteのdefault branchをauthoritative metadataから解決する（通常は`main`、存在しなければ`master`等。名前を推測しない）
- 確定したtarget branchがremoteに存在することを確認し、そのexact refとOIDをfetchしてstart pointにする。作業branchを`main`へ固定したり、targetと異なるbranchから切ったりしない
- `.worktree/` 配下へ専用 worktree を作り、移動してから編集を始める

```bash
set -euo pipefail
git worktree list
git status --short
# PRのtarget/baseが明示されている場合はそれを設定する。
# 未指定の場合だけremote defaultを解決する。
target_branch="${PR_TARGET_BRANCH:-}"
if test -z "$target_branch"; then
  remote_meta=$(git ls-remote --symref origin HEAD)
  target_full_ref=$(printf '%s\n' "$remote_meta" | awk '$1 == "ref:" && $3 == "HEAD" { print $2 }')
else
  target_full_ref="refs/heads/$target_branch"
fi
case "$target_full_ref" in refs/heads/*) ;; *) exit 1 ;; esac
target_branch=${target_full_ref#refs/heads/}
target_oid=$(git ls-remote origin "$target_full_ref" | awk 'NR == 1 { print $1 }')
test -n "$target_oid"
git fetch --no-tags origin "$target_full_ref"
test "$(git rev-parse FETCH_HEAD)" = "$target_oid"
printf 'PR target: %s (%s)\n' "$target_branch" "$target_oid"
mkdir -p .worktree
git worktree add .worktree/feature-short-name -b feature/short-name "$target_oid"
cd .worktree/feature-short-name
git rev-parse --show-toplevel
git branch --show-current
```

## Root Checkout Recovery Guidelines

- root checkout での追加編集を止める
- 上記のauthoritative remote HEAD解決手順で正しいbranch/worktreeを作る
- shared stash stackは全worktree/processで共有されるため、無条件の`git stash pop`による移植は禁止する
- tracked変更は権限を制限した一時patchへ書き、target側で`git apply --check`後に適用する
- untracked fileはNUL区切り一覧を確認し、targetに既存pathがないものだけ明示的に移す
- targetで差分を検証するまでroot checkout側の変更を削除しない。移植後もroot側cleanupは別の明示的手順として行う
- root checkoutはfeature完了まで作業場所として使わない

```bash
set -euo pipefail
# 上の手順でtarget_oidを確定済みのroot checkoutから
umask 077
patch_file=$(mktemp)
untracked_file=$(mktemp)
git diff --binary HEAD > "$patch_file"
git ls-files -z --others --exclude-standard > "$untracked_file"
git worktree add .worktree/feature-short-name -b feature/short-name "$target_oid"
git -C .worktree/feature-short-name apply --check "$patch_file"
git -C .worktree/feature-short-name apply "$patch_file"
# untracked_fileをNUL対応toolでレビューし、衝突しないfileだけ個別にcopyする
git -C .worktree/feature-short-name status --short
git status --short  # まだ原本を保持していることを確認
```

一時fileはtargetとrootの検証完了後に削除する。自動移植が必要なら`fail-closed-automation`を適用し、artifact ownershipとconcurrent writerを別途扱う。

## Minimum-Diff and Scope Gate

明示的なPR target/base branchがある場合はそれを起点にし、ない場合だけauthoritative remote metadataからdefault branchを解決する。通常は`main`、存在しなければ`master`等だが、branch名を推測しない。

作業開始前に、以下を確認する。

- 目的、受け入れ条件、変更対象、PR target/base branchを列挙する
- 現在のbranch、worktree、確定したtarget branchとの差分を確認する
- target branchがremoteに存在し、取得したOIDと一致することを確認する
- 各変更が目的達成に必要かを確認する
- 未マージbranch、作業途中worktree、関連機能の実装を暗黙の土台にしない
- 関連機能を含める場合は、import、route、schema、runtime call、再現可能な失敗ログなどの具体的な依存を確認する

実装後は、作業開始時に確定したPR target/base branchとの差分を再確認し、目的外の変更を除去する。依存関係を実証できない関連機能はスコープ外として扱う。

## Portable Change-Target Gate

repositoryやagentをまたいで変更を展開する場合、Hermes/Codex等のagent固有機能や、ロード済みskillの記憶だけでtargetを決めない。リポジトリ非依存の`skills/change-target-gate/scripts/change-target-gate.mjs`を実行し、manifestで宣言したrepository・base・artifact・pathだけを変更対象にする。

```bash
# 既存artifactを先に探索する
node skills/change-target-gate/scripts/change-target-gate.mjs discover --repo . --query "git workflow"

# 作業前後に、repository ownership・patch/create・実際のdiffを検証する
node skills/change-target-gate/scripts/change-target-gate.mjs verify \
  --policy config/change-target-policy.json \
  --manifest /path/to/change-target-manifest.json \
  --base <resolved-pr-target>
```

`--base`には作業開始時に確定したPR target/base branch（例: `origin/main`、`origin/master`、`origin/release/1.x`）を渡す。`main`を固定値として渡したり、targetと異なるbranchを暗黙に使用したりしない。

- `patch`対象がbase refに存在しない場合、`create`対象が既に存在する場合は停止する
- originのrepository、manifestのrepository、target repositoryが一致しない場合は停止する
- manifestにないchanged path、base ref不在、target未宣言を成功扱いにしない
- 複数repositoryへ展開する場合は、repositoryごとにsource of truthとmanifestを解決し、各repositoryで独立してgateを実行する。Hermesを特別扱いして禁止するのではなく、未計画targetだけを拒否する
- `config/change-target-policy.json`はこのrepositoryのadapterであり、共通の判定ロジックを複製して他agentへ埋め込まない。各repositoryは自分のcanonical repositoryとallowlistを定義する
- gateが失敗した状態で編集、commit、push、issue/PR作成を続行しない

## Commit / Rebase / Push Guidelines

- status を見ずに commit しない
- staged diff を見ずに commit しない
- commit 前に `git diff --cached` で commit 対象を最終確認する
- branch 名を見ずに push しない
- push / PR 前に公開したい commit SHA を確認する
- push 前に意図しない file が含まれていないか再確認する
- conflict解消前にも、作業開始時に確定したPR target/base branchを再照会し、exact refをfetchしてOID一致を検証する。そのtarget branchへrebaseする。`main`/`master`へguessしたり、remote default branchへ勝手にrebaseしたりしない

## Cleanup Guidelines

- cleanup は root checkout と worktree のどちらに対して行うか明確にしてから実行する
- `.worktree/` 自体を誤って消さない
- `git clean`はquarantine・identity再検証・rollbackがないためcleanup手段として使わない
- root checkout の status に `.worktree/` が出る場合は、repository の local exclude で隠すことを優先する
  - `.gitignore` を変更せずに隠すには root checkout で `echo '.worktree/' >> .git/info/exclude`
- 手動cleanupでもtrackedだけでなくuntracked・ignored fileを個別に検査し、1つでもあれば削除しない
- 手動・自動を問わず破壊的cleanupでは`fail-closed-automation` skillを併用し、そのGit worktree cleanup predicatesをauthoritativeな安全要件として適用する
- 最低限、tracked・untracked・ignoredが空であること、authoritative remote default名/OIDとexact merge evidenceが削除直前にも一致すること、quarantineをraw renameではなく`git worktree move`で行えることを要求する
- worktree登録を削除して登録消滅を確認後も、無人cleanupではlocal branchを保持して明示的なfollow-up対象として報告する。通常のGit CLIでは別worktreeへのconcurrent checkoutとref削除をatomicに調整できないため、自動branch削除は行わない。remote branchも明示依頼なしに削除しない
- 手動cleanupでも以下のread-only検査だけを根拠に削除してはいけない。検査後に上記のauthoritative remote/OID、merge evidence、`git worktree move` quarantine、削除直前再検証をすべて実施する

```bash
git -C .worktree/feature-short-name status --short
git -C .worktree/feature-short-name ls-files --others --exclude-standard
git -C .worktree/feature-short-name ls-files --others --ignored --exclude-standard
```

`git worktree remove`や`git branch -d`をこのsnapshotだけに続けるshortcutは禁止する。無人cleanupはlocal branchを保持し、手動cleanupでも削除直前に全predicateと別worktreeで未使用であることを再検証する。

## Common Pitfalls

- dirty な root checkout を安全な作業場所だと誤認する
- `.worktree/` が存在するだけで、既に専用 worktree 内にいると思い込む
- linked worktree 内でさらに `.worktree/` を作り、worktree を入れ子にする
- agent やツールが作成した linked worktree の detached HEAD を見落としたまま commit する
- root checkout にいるのに `.worktree/` を optional な慣習扱いして feature 作業を続ける
- tracked file だけ戻して untracked file を置き去りにする
- `git diff --cached` を見ずに commit する
- branch 名や commit SHA を確認せず push / PR を作成する
- cleanup 系コマンドを対象確認なしで実行する
- feature 作業後も main checkout に変更を残す

## Mandatory Skill Enforcement

- この skill が load されたら、git 操作を始める前に repository root / Git dir / common Git dir / branch / worktree / working tree 状態を必ず確認すること
- `git_dir != common_dir` なら現在の linked worktree を再利用し、新しい worktree を作成しないこと
- `.worktree/` 以下で起動した場合、既存の linked worktree を再利用し、共有 `.git` へ書き込む `git worktree add` を試行しないこと
- `git_dir == common_dir` でコード変更を行うなら、root checkout ではなく `.worktree/` 配下の専用 worktree を作成して移動すること
- detached HEAD のまま commit / rebase / push しないこと
- コード変更を伴う作業では、専用 worktree 内にいることと適切な専用 branch にいることを完了前に必ず再確認すること
- commit / push を行う場合、完了報告前に `git diff --cached` と対象 branch / commit SHA を必ず確認すること
- main checkout に feature 変更が残っている場合、その時点で未完了として扱い、cleanup を優先すること
- root checkout で変更を続けていた、または `.worktree/` guideline に違反していた場合、その時点で未完了として扱い、worktree への移植と root の復元を優先すること
